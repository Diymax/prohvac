// Сессии админки: выдача, проверка, продление, ротация и отзыв.
//
// ЧТО ИМЕННО ЛЕЖИТ В БАЗЕ. Ни сессионного токена, ни CSRF-токена в открытом
// виде в таблице sessions нет — только sha256 от них. Дамп базы (забытый бэкап
// на shared-хостинге, украденный файл, чтение через дыру в соседнем месте)
// не должен давать возможность подставить чужую куку: из хеша токен обратно
// не достаётся. Токен — 256 случайных бит, перебирать его нечем, поэтому соль
// и медленный KDF здесь не нужны, а быстрый sha256 оставляет поиск сессии
// обычным чтением по первичному ключу.
//
// ip_hash и ua_hash — наоборот, HMAC с APP_SECRET, а не голый sha256: всё
// пространство IPv4 перебирается за минуты, и несекретный хеш адреса
// разворачивается радужной таблицей обратно в адрес.
//
// ВСЁ СОСТОЯНИЕ В SQLITE. Под Passenger работает пул процессов, и запросы
// одного пользователя произвольно раскидываются между ними. Любой кэш сессий
// в памяти означал бы, что отзыв виден одному воркеру из четырёх, а «выйти
// на всех устройствах» не работает.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { parseCookies, serializeCookie } from '../http/cookies.js'

// Имя с префиксом __Host-: браузер примет такую куку только по HTTPS, только
// с Path=/ и без Domain, поэтому её невозможно подсадить с соседнего
// поддомена. Инварианты префикса проверяет serializeCookie.
export const SESSION_COOKIE = '__Host-pv_sid'

// 32 байта = 256 бит. base64url, потому что значение куки не должно требовать
// процентного кодирования: '-' и '_' проходят как есть.
export const TOKEN_BYTES = 32

// Как часто продлевать сессию записью в базу. Без порога UPDATE уходил бы
// на каждый запрос админки (в том числе на каждую картинку и каждый XHR),
// то есть на каждый чих — транзакция и fsync на общем диске.
export const TOUCH_INTERVAL_MS = 60_000

// Сколько отозванная строка живёт до физического удаления. Отзыв не стирает
// сессию сразу: в аудите должно оставаться видно, когда и почему человека
// разлогинило. Неделя — компромисс с диском в 500 МБ.
export const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const SESSION_STATES = new Set(['pending_totp', 'active'])

// Ровно тот список, что зашит в CHECK таблицы sessions. Проверяем в JS, чтобы
// опечатка в причине падала предсказуемой ошибкой здесь, а не констрейнтом
// SQLite посреди разлогина — и не превращала штатный выход в 500.
export const REVOKE_REASONS = new Set([
  'logout',
  'logout_all',
  'password_change',
  'admin',
  'expired',
  'ip_change',
  'totp_failed',
])

const SQL_INSERT = `
  INSERT INTO sessions (
    id, user_id, csrf_hash, state, amr, reauth_at,
    ip_hash, ua_hash, created_at, last_seen_at,
    idle_expires_at, absolute_expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING *
`

const SQL_SELECT = 'SELECT * FROM sessions WHERE id = ?'

// Условия WHERE — не украшение: они не дают продлить уже мёртвую или отозванную
// сессию (иначе просроченная воскресала бы первым же запросом), а last_seen_at
// делает порог TOUCH_INTERVAL_MS общим для всего пула процессов, а не локальным
// решением одного воркера.
const SQL_TOUCH = `
  UPDATE sessions
     SET last_seen_at = ?, idle_expires_at = ?
   WHERE id = ?
     AND revoked_at IS NULL
     AND idle_expires_at > ?
     AND absolute_expires_at > ?
     AND last_seen_at <= ?
`

const SQL_REVOKE = `
  UPDATE sessions
     SET revoked_at = ?, revoked_reason = ?
   WHERE id = ? AND revoked_at IS NULL
`

const SQL_REVOKE_ALL = `
  UPDATE sessions
     SET revoked_at = ?, revoked_reason = ?
   WHERE user_id = ? AND revoked_at IS NULL AND id <> ?
`

const SQL_GC_EXPIRE = `
  UPDATE sessions
     SET revoked_at = ?, revoked_reason = 'expired'
   WHERE revoked_at IS NULL
     AND (idle_expires_at <= ? OR absolute_expires_at <= ?)
`

const SQL_GC_DELETE = 'DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at <= ?'

// Соединение приходит снаружи, поэтому подготовленные statement'ы нельзя
// сложить в замыкание, как в server/lib/ratelimit.js. Кэш на WeakMap: повторный
// prepare — это повторный разбор SQL на каждом запросе, а слабые ссылки не
// удерживают закрытое соединение (актуально для тестов, где баз десятки).
const statements = new WeakMap()

const prepared = (db, sql) => {
  let byDb = statements.get(db)
  if (!byDb) {
    byDb = new Map()
    statements.set(db, byDb)
  }
  let statement = byDb.get(sql)
  if (!statement) {
    statement = db.prepare(sql)
    byDb.set(sql, statement)
  }
  return statement
}

// Транзакции принадлежат драйверу (server/db/driver.js): он считает глубину и
// на вложенном вызове открывает SAVEPOINT вместо второго BEGIN IMMEDIATE,
// который SQLite отвергает. Собственной копии здесь быть не должно — прошлая
// проверяла db.isTransaction, свойства с таким именем у обёртки нет вовсе,
// поэтому вложенный вызов гарантированно падал.
const transact = (db, fn) => {
  if (typeof db.transaction !== 'function') {
    throw new TypeError(
      'session: требуется соединение из server/db (driver.transaction), ' +
      'сырой DatabaseSync не умеет вложенные транзакции'
    )
  }
  return db.transaction(fn)
}

const assertPositiveInt = (name, value) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`session: ${name} должен быть целым > 0, получено ${value}`)
  }
  return value
}

const assertSecret = (secret) => {
  // Пустой секрет молча превратил бы HMAC в предсказуемую функцию от адреса:
  // ip_hash перестал бы быть псевдонимом и стал бы просто хешем IP.
  if (typeof secret !== 'string' || !secret) {
    throw new Error('session: APP_SECRET пуст — ip_hash и ua_hash были бы обратимы')
  }
  return secret
}

const assertState = (state) => {
  if (!SESSION_STATES.has(state)) {
    throw new Error(`session: недопустимое состояние ${JSON.stringify(state)}`)
  }
  return state
}

const assertReason = (reason) => {
  if (reason == null) return null
  if (!REVOKE_REASONS.has(reason)) {
    throw new Error(`session: недопустимая причина отзыва ${JSON.stringify(reason)}`)
  }
  return reason
}

/** amr удобно собирать массивом ('pwd', 'otp'), а в базе это строка через запятую. */
const normalizeAmr = (amr) => {
  const list = Array.isArray(amr) ? amr : String(amr ?? '').split(',')
  const clean = list.map((item) => String(item).trim()).filter(Boolean)
  if (!clean.length) throw new Error('session: amr не может быть пустым')
  return clean.join(',')
}

/** Хеш токена = первичный ключ строки в sessions. Экспортирован ради тестов
 *  и вызовов вида «отозвать всё, кроме текущей куки». */
export const hashSessionToken = (token) =>
  createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex')

/** Псевдоним адреса или User-Agent: HMAC-SHA256 в нижнем регистре hex, ровно
 *  64 символа — именно это проверяет CHECK в схеме. */
export const hashClientValue = (value, secret = config.appSecret) =>
  createHmac('sha256', assertSecret(secret)).update(String(value ?? ''), 'utf8').digest('hex')

const newToken = () => randomBytes(TOKEN_BYTES).toString('base64url')

const sessionId = (target) => {
  if (typeof target === 'string') return target
  const id = target?.id
  if (typeof id !== 'string' || !id) {
    throw new TypeError('session: ожидается строка id или строка сессии из БД')
  }
  return id
}

/**
 * Создаёт сессию и возвращает секреты, которые больше нигде не появятся:
 * в базе лежат только их хеши, поэтому отдать токен вызывающему коду можно
 * ровно один раз — здесь.
 *
 * token уходит в куку, csrfToken — в тело ответа (SPA держит его в памяти).
 * В куку CSRF-токен класть не нужно: сравнивается он с хешем из строки сессии,
 * то есть это synchronizer token, а не классический double-submit на куках.
 *
 * @param {object} db соединение node:sqlite (DatabaseSync)
 * @param {{userId: number, state?: string, ip?: string, ua?: string,
 *          amr?: string|string[], reauthAt?: number|null, now?: number,
 *          idleMs?: number, absoluteMs?: number, secret?: string}} options
 * @returns {{token: string, csrfToken: string, session: object}}
 */
export const createSession = (db, options = {}) => {
  const {
    userId,
    // По умолчанию сессия неполноценная: пароль принят, второго фактора ещё
    // нет. Пускать с ней куда-либо, кроме проверки кода, нельзя.
    state = 'pending_totp',
    ip = '',
    ua = '',
    amr = 'pwd',
    now = Date.now(),
    // Сессия заводится сразу после проверки пароля, поэтому подтверждение
    // пароля свежее по определению. Опасные операции сверяются с этой меткой.
    // null, а НЕ now. Метка означает «пароль подтверждён явно и недавно»,
    // и проставлять её при самом создании сессии значит объявить свежими
    // первые десять минут любой новой сессии. Тогда угнанная кука в это окно
    // перепривязывает второй фактор и перевыпускает коды восстановления —
    // ровно то, от чего requireFreshReauth должен защищать.
    // Метку ставит только явный POST /api/admin/reauth.
    reauthAt = null,
    idleMs = config.sessionIdleMs,
    absoluteMs = config.sessionAbsoluteMs,
    secret = config.appSecret,
  } = options

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new TypeError(`session: userId должен быть целым > 0, получено ${userId}`)
  }
  assertState(state)
  assertPositiveInt('now', now)
  assertPositiveInt('idleMs', idleMs)
  assertPositiveInt('absoluteMs', absoluteMs)
  assertSecret(secret)

  const token = newToken()
  const csrfToken = newToken()

  const session = prepared(db, SQL_INSERT).get(
    hashSessionToken(token),
    userId,
    hashSessionToken(csrfToken),
    state,
    normalizeAmr(amr),
    reauthAt == null ? null : assertPositiveInt('reauthAt', reauthAt),
    hashClientValue(ip, secret),
    hashClientValue(ua, secret),
    now,
    now,
    now + idleMs,
    now + absoluteMs
  )

  return { token, csrfToken, session }
}

/**
 * Находит живую сессию по токену из куки.
 *
 * Намеренно только читает. Отметить просроченную строку как revoked было бы
 * приятно для аудита, но это запись в базу на каждый запрос с мёртвой кукой —
 * то есть бесплатный способ нагрузить диск. Уборку делает gcSessions.
 *
 * @returns {{ok: true, session: object} | {ok: false, error: string, userId?: number}}
 */
export const loadSession = (db, token, { now = Date.now() } = {}) => {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'missing_token' }

  const session = prepared(db, SQL_SELECT).get(hashSessionToken(token))
  if (!session) return { ok: false, error: 'not_found' }

  // На отказных ветках строку не возвращаем — только user_id для журнала.
  // Иначе вызывающий код рано или поздно достанет session из ответа, забыв
  // проверить ok, и мёртвая сессия окажется рабочей.
  const denied = (error) => ({ ok: false, error, userId: session.user_id })

  if (session.revoked_at != null) return denied('revoked')
  // Абсолютный срок проверяем первым: он важнее и не сдвигается активностью.
  if (session.absolute_expires_at <= now) return denied('expired')
  if (session.idle_expires_at <= now) return denied('idle_expired')

  return { ok: true, session }
}

/**
 * Продлевает окно бездействия, но не чаще раза в TOUCH_INTERVAL_MS.
 * Обновляет переданный объект сессии на месте, чтобы дальше по обработке
 * запроса не осталось устаревших сроков.
 *
 * @returns {boolean} была ли запись в базу
 */
export const touchSession = (db, session, options = {}) => {
  const {
    now = Date.now(),
    idleMs = config.sessionIdleMs,
    intervalMs = TOUCH_INTERVAL_MS,
  } = options

  const id = sessionId(session)
  assertPositiveInt('idleMs', idleMs)

  // Дешёвая отсечка до похода в базу. Авторитетная проверка того же порога
  // живёт в SQL: воркеры видят разные копии строки и решать в памяти нельзя.
  if (typeof session?.last_seen_at === 'number' && now - session.last_seen_at < intervalMs) {
    return false
  }

  const idleExpiresAt = now + idleMs
  const { changes } = prepared(db, SQL_TOUCH).run(
    now,
    idleExpiresAt,
    id,
    now,
    now,
    now - intervalMs
  )
  if (!changes) return false

  if (session && typeof session === 'object') {
    session.last_seen_at = now
    session.idle_expires_at = idleExpiresAt
  }
  return true
}

/**
 * Заводит новую строку сессии с новым токеном и отзывает старую.
 *
 * ЗАЧЕМ. Это защита от фиксации сессии (session fixation). Если атакующий смог
 * навязать браузеру жертвы известный ему идентификатор — через XSS на соседнем
 * поддомене, через подсунутую ссылку, через доступ к чужому компьютеру до
 * входа, — то без ротации он получит доступ ровно в тот момент, когда жертва
 * успешно войдёт: идентификатор-то останется прежним, а прав у него прибавится.
 * Поэтому токен обязан смениться на каждом повышении уровня доверия:
 * после успешной проверки второго фактора (pending_totp -> active)
 * и после смены пароля. Старая строка при этом помечается revoked, а не
 * удаляется, чтобы в аудите осталась история.
 *
 * absolute_expires_at и created_at наследуются от старой строки: это та же
 * сессия, у неё лишь сменился токен. Если сбрасывать абсолютный срок при
 * каждой ротации, жёсткий потолок жизни сессии перестанет наступать вообще.
 *
 * @returns {{token: string, csrfToken: string, session: object}}
 */
export const rotateSession = (db, session, options = {}) => {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session: rotateSession ожидает строку сессии из БД')
  }

  const {
    state = session.state,
    amr = session.amr,
    now = Date.now(),
    idleMs = config.sessionIdleMs,
    reauthAt = session.reauth_at,
    // В CHECK схемы отдельной причины «ротация» нет, поэтому по умолчанию
    // причина пустая: смысл записи ясен из того, что рядом появилась новая
    // сессия того же пользователя. Смена пароля передаёт 'password_change'.
    reason = null,
  } = options

  const oldId = sessionId(session)
  assertState(state)
  assertPositiveInt('now', now)
  assertPositiveInt('idleMs', idleMs)
  assertReason(reason)

  const token = newToken()
  const csrfToken = newToken()

  // Обе записи в одной транзакции: между ними нельзя оказаться в состоянии
  // «старая сессия уже отозвана, новой ещё нет» (человека выбросило посреди
  // ввода кода) или «живы обе» (ротация не состоялась, а вызывающий код
  // считает, что состоялась).
  const fresh = transact(db, () => {
    prepared(db, SQL_REVOKE).run(now, reason, oldId)

    return prepared(db, SQL_INSERT).get(
      hashSessionToken(token),
      session.user_id,
      hashSessionToken(csrfToken),
      state,
      normalizeAmr(amr),
      reauthAt == null ? null : reauthAt,
      // Хеши копируем, а не считаем заново: клиент тот же самый, и пересчёт
      // потребовал бы тащить сюда сырые ip/ua и секрет без всякой пользы.
      session.ip_hash,
      session.ua_hash,
      session.created_at,
      now,
      now + idleMs,
      session.absolute_expires_at
    )
  })

  return { token, csrfToken, session: fresh }
}

/**
 * Отзывает одну сессию. Принимает и строку из БД, и готовый id.
 * Повторный вызов ничего не меняет: WHERE revoked_at IS NULL не даёт
 * переписать причину и время первого отзыва.
 *
 * @returns {number} сколько строк изменилось (0 или 1)
 */
export const revokeSession = (db, target, options = {}) => {
  const { reason = 'logout', now = Date.now() } = options
  assertReason(reason)
  return prepared(db, SQL_REVOKE).run(now, reason, sessionId(target)).changes
}

/**
 * «Выйти на всех устройствах», а также обязательный шаг после смены пароля:
 * старый пароль мог утечь, и все выданные по нему сессии должны умереть.
 *
 * exceptId оставляет живой текущую сессию — обычно уже ротированную, иначе
 * человек, сменивший пароль, разлогинивает сам себя.
 *
 * @returns {number} сколько сессий отозвано
 */
export const revokeAllForUser = (db, userId, options = {}) => {
  const { reason = 'logout_all', now = Date.now(), exceptId = null } = options
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new TypeError(`session: userId должен быть целым > 0, получено ${userId}`)
  }
  assertReason(reason)

  // id <> '' истинно для всех настоящих строк, поэтому пустая строка работает
  // как «не исключать никого» и не требует второго варианта запроса.
  const keep = exceptId == null ? '' : sessionId(exceptId)
  return prepared(db, SQL_REVOKE_ALL).run(now, reason, userId, keep).changes
}

/**
 * Уборка. Два шага, потому что у них разный смысл: сначала просроченные живые
 * сессии получают явную причину смерти (в аудите «истекла» отличается от
 * «вышел сам»), и только отлежавшие retentionMs строки удаляются физически.
 *
 * Вызывать из планировщика, а не из обработчика запроса: DELETE по всей таблице
 * не должен попадать на горячий путь.
 *
 * @returns {{expired: number, deleted: number}}
 */
export const gcSessions = (db, now = Date.now(), { retentionMs = REVOKED_RETENTION_MS } = {}) => {
  assertPositiveInt('now', now)
  assertPositiveInt('retentionMs', retentionMs)

  return transact(db, () => {
    const expired = prepared(db, SQL_GC_EXPIRE).run(now, now, now).changes
    const deleted = prepared(db, SQL_GC_DELETE).run(now - retentionMs).changes
    return { expired, deleted }
  })
}

/** Токен сессии из заголовка Cookie. Пустая строка, если куки нет. */
export const readSessionToken = (req) => {
  const value = parseCookies(req)[SESSION_COOKIE]
  return typeof value === 'string' ? value : ''
}

/**
 * Set-Cookie с сессионным токеном.
 *
 * Secure стоит всегда, в том числе локально: http://localhost браузеры считают
 * доверенным происхождением и Secure-куку по нему принимают, поэтому отдельная
 * поблажка для разработки не нужна и не появится случайно в проде.
 *
 * SameSite=Strict, а не Lax: в админку не приходят по внешним ссылкам, зато
 * Lax отправляет куку при переходе по ссылке с чужого сайта — то есть на
 * GET-запрос, который можно спровоцировать.
 *
 * Max-Age по умолчанию не выставляется: срок жизни сессии решает база, а кука
 * без Max-Age умирает вместе с окном браузера. Кука, пережившая строку в БД,
 * не даёт ничего, кроме лишнего запроса и разлогина в неожиданный момент.
 */
export const sessionCookie = (token, { maxAgeSec } = {}) =>
  serializeCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    ...(maxAgeSec == null ? {} : { maxAge: maxAgeSec }),
  })

/** Гасит куку при выходе. Max-Age=0 — единственный способ удалить её у клиента;
 *  атрибуты обязаны совпадать с теми, с которыми она ставилась. */
export const clearSessionCookie = () =>
  serializeCookie(SESSION_COOKIE, '', {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 0,
  })
