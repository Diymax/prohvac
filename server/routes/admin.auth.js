// Вход в админку: пароль, второй фактор, выход, смена пароля, повторное
// подтверждение личности.
//
// ЕДИНЫЙ ОТВЕТ НА ЛЮБУЮ НЕУДАЧУ ВХОДА. «Нет такого пользователя», «пароль
// неверный» и «учётка заблокирована» отвечают одинаково: 401 с
// invalid_credentials. Отдельный код account_locked выглядит вежливым, но
// стоит дорого сразу дважды. Во-первых, это оракул существования: перебором
// логинов собирается список действующих учёток, а дальше перебор идёт только
// по ним. Во-вторых, это готовый инструмент отказа в обслуживании: зная, что
// пять неудач лочат аккаунт, любой желающий блокирует владельца сайта пятью
// запросами и наблюдает по ответу, что получилось.
//
// ВРЕМЯ ОТВЕТА — ТАКОЙ ЖЕ КАНАЛ УТЕЧКИ, КАК ТЕЛО. Ранний выход на «нет такого
// пользователя» отвечает мгновенно, а проверка настоящего пароля занимает
// десятки миллисекунд scrypt — разница уверенно измеряется по сети. Поэтому:
//   1. по несуществующему логину пароль ВСЁ РАВНО проверяется, против
//      DECOY_HASH (пустышка, пароля от которой не знает никто);
//   2. любая ветка — и отказная, и успешная — доводится до общего пола
//      через settleAt(startedAt, SETTLE_FLOOR_MS).
//
// ВСЁ СОСТОЯНИЕ В SQLITE. Passenger держит пул процессов, счётчики попыток
// и блокировки в памяти считались бы у каждого свои.

import { createHash, createHmac } from 'node:crypto'

import { config } from '../config.js'
import { deriveKey, open, PURPOSE } from '../crypto/secretbox.js'
import { readJson } from '../http/body.js'
import { json } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { capabilitiesFor } from '../policies/capabilities.js'
import { createRateLimiter, progressiveDelayMs } from '../lib/ratelimit.js'
import { settleAt } from '../lib/timing.js'
import { verifyCsrf } from '../auth/csrf.js'
import { denyAsNotFound, requireActive, requireSession } from '../auth/guard.js'
// Эскалация по АДРЕСУ: счётчик неудач за окно, детект перебора списка логинов
// и блокировка ip_blocks. Это отдельный уровень от локального registerFailure
// ниже — тот запирает УЧЁТКУ, а этот закрывает адрес, с которого перебирают
// разные учётки по одной-две попытки (credential stuffing).
import { createThrottle } from '../auth/throttle.js'
// Коды восстановления выдаёт и проверяет один модуль: две реализации
// хеширования гарантированно разъезжаются, что здесь и произошло.
import { consumeRecoveryCode } from './admin.2fa.js'
import {
  DECOY_HASH,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../auth/password.js'
import {
  clearSessionCookie,
  createSession,
  revokeAllForUser,
  revokeSession,
  rotateSession,
  sessionCookie,
} from '../auth/session.js'
import { verifyTotp } from '../auth/totp.js'

// Тело здесь — это два коротких поля. 2 КБ с запасом: всё, что больше,
// заведомо не форма входа.
const BODY_LIMIT = 2 * 1024

// Пол длительности ответа. 300 мс заметно больше разброса scrypt на одном
// железе, поэтому ветки перестают различаться, и при этом человек паузу
// не воспринимает как «сайт тормозит».
const SETTLE_FLOOR_MS = 300

// Сколько живёт промежуточная сессия между паролем и вторым фактором.
// Пять минут — это ввести код из приложения, а не «оставлю вкладку на день».
// Задаётся как окно бездействия и НЕ продлевается (см. guard.js).
export const PENDING_TTL_MS = 5 * 60_000

// Столько же, но для ПЕРВИЧНОЙ привязки, когда подтверждённого секрета ещё нет.
//
// Пять минут здесь были ошибочной меркой: у человека на этой стадии нет
// приложения-аутентификатора — его надо найти в магазине, установить, выдать
// доступ к камере и только потом сканировать QR. Сессия истекала посреди этого,
// а нажатие «Подтвердить привязку» получало uniform404 и возвращало на форму
// входа. Снаружи это выглядело так, будто привязка не работает вовсе.
//
// Двадцать минут — всё ещё окно бездействия, которое не продлевается: сессия
// на этой стадии не даёт ничего, кроме самой привязки.
export const ENROLL_TTL_MS = 20 * 60_000

// Попыток второго фактора на одну промежуточную сессию. Дальше сессия
// уничтожается, и вход начинается заново с пароля: иначе украденный
// «полувход» даёт неограниченный перебор шестизначного кода.
export const MAX_TOTP_ATTEMPTS = 5

// Лимитер входа. Два независимых ведра: по адресу и по логину. Только по
// адресу — и распределённый перебор одного пароля с сотни адресов проходит
// незамеченным; только по логину — и перебор логинов с одного адреса тоже.
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_MAX_PER_IP = 30
const LOGIN_MAX_PER_USER = 10

// Проверка пароля внутри уже открытой сессии (смена пароля, reauth) — тоже
// перебор, просто требующий украденной куки. Ведро отдельное и мягче.
const REAUTH_WINDOW_MS = 15 * 60_000
const REAUTH_MAX = 10

// Блокировка учётки после подряд идущих неудач. Срок растёт с каждым
// уровнем: разовая опечатка стоит минуту, упорный перебор — часы.
const LOCK_THRESHOLD = 5
const LOCK_STEPS_MS = Object.freeze([
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
])

const SQL_FIND_USER = `
  SELECT id, username, password_hash, role, status, must_change_password,
         totp_required, failed_attempts, lock_level, locked_until
    FROM users
   WHERE username = ?
`

const SQL_PASSWORD_HASH = 'SELECT password_hash FROM users WHERE id = ?'

// Только подтверждённый секрет: пока пользователь не ввёл первый код,
// секрет существует, но вторым фактором не является.
const SQL_TOTP_SECRET = `
  SELECT secret_ct, secret_iv, secret_tag, digits, period, algorithm, last_used_step
    FROM totp_secrets
   WHERE user_id = ? AND confirmed_at IS NOT NULL
`

// Запросы к recovery_codes жили здесь и искали код по точному совпадению
// HMAC-хеша, тогда как выдача хешировала его через scrypt. Совпасть они
// не могли, поэтому вся работа с кодами восстановления вынесена туда же,
// где коды создаются, — в admin.2fa.js (consumeRecoveryCode).

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const SQL_ATTEMPT = `
  INSERT INTO login_attempts (at, username, ip_hash, stage, outcome) VALUES (?, ?, ?, ?, ?)
`

// ---------------------------------------------------------------------------
// CSRF-токен
// ---------------------------------------------------------------------------

// В sessions лежит только sha256 от CSRF-токена, прообраз оттуда не достать.
// А GET /api/admin/session обязан вернуть рабочий токен: SPA после
// перезагрузки страницы держит в руках одну лишь куку.
//
// Вариант «выдавать новый токен на каждый GET» ломает вторую вкладку — её
// токен умирает молча, и следующая мутация падает без внятной причины.
// Поэтому токен ВЫВОДИТСЯ из сессионного: csrf = HMAC(ключ, 'csrf|' + token).
// Свойства сохраняются: угадать его нельзя (сессионный токен — 256 случайных
// бит в HttpOnly-куке), утечка CSRF-токена не раскрывает сессионный (HMAC
// необратим), а в базе по-прежнему только sha256. Зато он восстановим на
// любом запросе, который эту куку принёс, и не требует записи.
const CSRF_PURPOSE = 'csrf-token'

const sha256hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

const csrfTokenFor = (sessionToken) =>
  createHmac('sha256', deriveKey(CSRF_PURPOSE))
    .update(`csrf|${sessionToken}`, 'utf8')
    .digest('base64url')

/**
 * Приводит csrf_hash строки сессии к выводимому токену и возвращает его.
 * createSession/rotateSession кладут в строку хеш СЛУЧАЙНОГО токена — его
 * и переписываем, ровно один UPDATE на выдачу сессии.
 */
const bindCsrf = (db, session, sessionToken) => {
  const csrfToken = csrfTokenFor(sessionToken)
  const hash = sha256hex(csrfToken)
  db.run('UPDATE sessions SET csrf_hash = ? WHERE id = ?', [hash, session.id])
  session.csrf_hash = hash
  return csrfToken
}

/**
 * Действующий CSRF-токен сессии. Если в строке лежит чужой хеш (сессию выдал
 * код, который про вывод токена не знает), молча перевыпускаем — иначе
 * пользователь получил бы токен, который не проходит собственную проверку.
 */
const csrfFor = (db, session, sessionToken) => {
  const csrfToken = csrfTokenFor(sessionToken)
  if (sha256hex(csrfToken) === session.csrf_hash) return csrfToken
  return bindCsrf(db, session, sessionToken)
}

// ---------------------------------------------------------------------------
// Коды восстановления
// ---------------------------------------------------------------------------

// Хеш кода восстановления — HMAC на ключе из APP_SECRET, а не голый sha256.
// Код несёт 50 бит энтропии: по дампу базы такой sha256 перебирается на
// видеокарте, а HMAC без ключа — нет, и ключа в дампе нет. Медленный KDF
// здесь неприменим: колонка code_hash уникальна, и поиск идёт ПО хешу,
// то есть он обязан быть детерминированным и дешёвым.
const RECOVERY_PURPOSE = 'recovery-code'

/** Канонический вид кода: 'a1b2c-3d4e5', 'A1B2C 3D4E5' и 'a1b2c3d4e5' — одно
 *  и то же, потому что человек перепечатывает код с бумаги. */
export const normalizeRecoveryCode = (code) =>
  String(code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')

/** Значение для recovery_codes.code_hash. Экспортируется, потому что тот же
 *  хеш обязан считать код, который коды ВЫДАЁТ: две реализации разойдутся. */
export const hashRecoveryCode = (code) =>
  createHmac('sha256', deriveKey(RECOVERY_PURPOSE))
    .update(normalizeRecoveryCode(code), 'utf8')
    .digest('hex')

// ---------------------------------------------------------------------------
// Мелочь общего назначения
// ---------------------------------------------------------------------------

/** Сессия умирает по любому из двух сроков, значит показывать надо ближний. */
const expiresAt = (session) =>
  Math.min(session.idle_expires_at, session.absolute_expires_at)

/** Что клиенту знать можно. Никаких id, хешей и счётчиков попыток. */
const sessionView = (user, session) => ({
  user: user.username,
  role: user.role,
  capabilities: capabilitiesFor(user, {
    accountActive: user.must_change_password !== 1,
  }),
  amr: session.amr,
  mustChangePassword: user.must_change_password === 1,
  expiresAt: expiresAt(session),
})

const audit = (db, entry) => {
  try {
    db.run(SQL_AUDIT, [
      entry.at ?? Date.now(),
      entry.userId ?? null,
      entry.actor || 'anonymous',
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.ipHash ?? null,
      entry.diff == null ? null : JSON.stringify(entry.diff),
      entry.result ?? 'ok',
    ])
  } catch (error) {
    // Журнал не должен ломать вход: невозможность записать строку аудита —
    // это повод для тревоги в логе, а не 500 на форме входа.
    console.error(`[admin.auth] аудит не записан (${entry.action}): ${error.message}`)
  }
}

const recordAttempt = (db, attempt) => {
  try {
    db.run(SQL_ATTEMPT, [
      attempt.at,
      attempt.username || null,
      attempt.ipHash,
      attempt.stage,
      attempt.outcome,
    ])
  } catch (error) {
    console.error(`[admin.auth] попытка входа не записана: ${error.message}`)
  }
}

/**
 * Учитывает неудачу в счётчиках АДРЕСА и, при переполнении, банит его.
 *
 * record: false — строку в login_attempts уже написал recordAttempt выше;
 * второй вызов удвоил бы счётчик, то есть и наказание.
 *
 * НА ОТВЕТ НЕ ВЛИЯЕТ НИЧЕГО. Возвращённое blocked сознательно игнорируется:
 * отдельный код ответа на «адрес только что забанили» — это оракул, по которому
 * подбирается сам порог. Блокировка сработает на СЛЕДУЮЩЕМ запросе, в dispatch
 * (server/app.js), и выглядеть будет как обычный несуществующий адрес.
 *
 * Сбой эскалации не ломает вход: она защита, а не часть обработки запроса.
 * Но и молчать нельзя — именно тихая ошибка однажды выключила её целиком.
 */
const escalateFailure = (escalation, params) => {
  try {
    escalation.registerFailure({ ...params, record: false })
  } catch (error) {
    console.error(`[admin.auth] эскалация не отработала: ${error.message}`)
  }
}

/**
 * Content-Type у формы входа проверяем отдельно и до всего остального.
 * verifyCsrf здесь неприменим (сессии ещё нет, синхронизирующий токен взять
 * неоткуда), но третий его барьер работает и в одиночку: HTML-форма умеет
 * ровно три типа тела, application/json среди них нет, а кросс-доменный fetch
 * с таким Content-Type уходит в preflight, на который мы не отвечаем.
 * То есть спровоцировать вход с чужой страницы (login CSRF) всё равно нельзя.
 */
const isJsonRequest = (req) =>
  String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() ===
  'application/json'

const readBody = async (req, res) => {
  const body = await readJson(req, { limit: BODY_LIMIT })
  if (body.ok) return body.value

  json(res, body.error === 'payload_too_large' ? 413 : 400, { ok: false, error: body.error })
  return null
}

/** Проверка CSRF для мутаций внутри сессии. Возвращает true, если можно дальше. */
const csrfPassed = (req, res, session, { contentTypes } = {}) => {
  const result = verifyCsrf(req, session, {
    publicOrigin: config.publicOrigin,
    ...(contentTypes === undefined ? {} : { contentTypes }),
  })
  if (result.ok) return true

  // Здесь уже 403, а не uniform404: сессия действующая, значит клиент и так
  // знает, что админка существует. Прятать от него нечего, а внятный код
  // ошибки экономит часы на разборе «почему не сохраняется».
  json(res, 403, { ok: false, error: result.error })
  return false
}

const tooManyRequests = (res, resetAt, now) => {
  const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000))
  res.setHeader('Retry-After', String(retryAfterSec))
  json(res, 429, { ok: false, error: 'rate_limited', retryAfterSec })
}

const normalizeUsername = (value) => {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  // Границы те же, что в CHECK таблицы users: строка вне их всё равно ничего
  // не найдёт, и тратить на неё запрос незачем.
  return name.length >= 3 && name.length <= 32 ? name : ''
}

const asString = (value) => (typeof value === 'string' ? value : '')

const isLocked = (user, now) => user.locked_until != null && user.locked_until > now

/** Учёт неудачи и, при переполнении, блокировка с растущим сроком. */
const registerFailure = (db, user, now) => {
  const attempts = user.failed_attempts + 1

  if (attempts < LOCK_THRESHOLD) {
    db.run('UPDATE users SET failed_attempts = ?, updated_at = ? WHERE id = ?', [
      attempts,
      now,
      user.id,
    ])
    return
  }

  // Счётчик обнуляем вместе с выдачей блокировки: следующие пять неудач
  // после её истечения дадут уже следующий уровень, а не мгновенный новый бан.
  const level = user.lock_level + 1
  const step = LOCK_STEPS_MS[Math.min(level, LOCK_STEPS_MS.length) - 1]
  db.run(
    `UPDATE users
        SET failed_attempts = 0, lock_level = ?, locked_until = ?, updated_at = ?
      WHERE id = ?`,
    [level, now + step, now, user.id]
  )
}

const registerSuccess = (db, userId, now) => {
  db.run(
    `UPDATE users
        SET failed_attempts = 0, lock_level = 0, locked_until = NULL,
            last_login_at = ?, updated_at = ?
      WHERE id = ?`,
    [now, now, userId]
  )
}

/**
 * Расшифрованный секрет TOTP или null. Порча записи (сменившийся APP_SECRET,
 * побитый BLOB) — это не 500 на форме: пользователь всё равно не войдёт
 * по коду, а причина уходит в лог и в аудит.
 */
const loadTotpSecret = (db, userId) => {
  const row = db.get(SQL_TOTP_SECRET, [userId])
  if (!row) return null

  try {
    const secret = open(
      { ct: row.secret_ct, iv: row.secret_iv, tag: row.secret_tag },
      PURPOSE.totpSecret
    )
    return { ...row, secret }
  } catch (error) {
    console.error(`[admin.auth] секрет TOTP пользователя ${userId} нечитаем: ${error.message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/session — пароль
// ---------------------------------------------------------------------------

const loginHandler = ({ db, throttle, escalation }) => async (req, res) => {
  const startedAt = Date.now()

  if (!isJsonRequest(req)) {
    json(res, 415, { ok: false, error: 'unsupported_media_type' })
    return
  }

  const body = await readBody(req, res)
  if (!body) return

  const { clientIp: ip, userAgent: ua, ipHash } = ensureRequestContext(req)
  const username = normalizeUsername(body.username)
  const password = asString(body.password)

  const byIp = throttle.hit(`login:ip:${ipHash}`, {
    windowMs: LOGIN_WINDOW_MS,
    max: LOGIN_MAX_PER_IP,
    now: startedAt,
  })
  // Ведро логина трогаем, ТОЛЬКО пока адресное не исчерпано. Иначе каждый
  // запрос с новым именем заводил бы в rate_limit новую строку — а имя
  // приходит из тела, то есть неаутентифицированный клиент растил бы таблицу
  // потоком уникальных логинов. Ответ 429 её появление не отменяет: hit()
  // вставляет строку до того, как вызывающий посмотрит на allowed.
  const byUser = username && byIp.allowed
    ? throttle.hit(`login:user:${username.toLowerCase()}`, {
      windowMs: LOGIN_WINDOW_MS,
      max: LOGIN_MAX_PER_USER,
      now: startedAt,
    })
    : { allowed: true, count: 0, resetAt: startedAt }

  // Прогрессивная задержка идёт ПОВЕРХ пола: перебор дорожает экспоненциально
  // задолго до того, как сработает жёсткий лимит по количеству.
  const penaltyMs = progressiveDelayMs(Math.max(byIp.count, byUser.count))

  const refuse = async (outcome, userId) => {
    recordAttempt(db, { at: startedAt, username, ipHash, stage: 'password', outcome })
    escalateFailure(escalation, {
      ipHash,
      username,
      stage: 'password',
      outcome,
      now: startedAt,
    })
    audit(db, {
      at: startedAt,
      userId,
      actor: username || 'anonymous',
      action: 'login.denied',
      entity: 'session',
      ipHash,
      diff: { outcome },
      result: 'denied',
    })
    await settleAt(startedAt, SETTLE_FLOOR_MS + penaltyMs)
    // Один ответ на все три причины — см. шапку файла.
    json(res, 401, { ok: false, error: 'invalid_credentials' })
  }

  if (!byIp.allowed || !byUser.allowed) {
    recordAttempt(db, { at: startedAt, username, ipHash, stage: 'password', outcome: 'rate_limited' })
    await settleAt(startedAt, SETTLE_FLOOR_MS + penaltyMs)
    tooManyRequests(res, Math.max(byIp.resetAt ?? 0, byUser.resetAt ?? 0), startedAt)
    return
  }

  const user = username ? db.get(SQL_FIND_USER, [username]) : null

  // Ровно одна проверка пароля на КАЖДОЙ ветке, включая «пользователя нет»
  // и «учётка заблокирована». Без этого отсутствие учётки отвечало бы за
  // микросекунды, а существующая — за десятки миллисекунд scrypt, и логины
  // отбирались бы по секундомеру. Результат для заблокированных не смотрим:
  // важно, что работа проделана.
  const usable = user && user.status === 'active' && !isLocked(user, startedAt)
  const passwordOk = await verifyPassword(password, usable ? user.password_hash : DECOY_HASH)

  if (!user) {
    await refuse('unknown_user', null)
    return
  }
  if (user.status !== 'active') {
    await refuse('disabled', user.id)
    return
  }
  if (isLocked(user, startedAt)) {
    await refuse('locked', user.id)
    return
  }
  if (!passwordOk) {
    registerFailure(db, user, startedAt)
    await refuse('bad_password', user.id)
    return
  }

  registerSuccess(db, user.id, startedAt)
  // Ведро логина чистим, адресное — нет: иначе владелец одной рабочей учётки
  // обнулял бы лимит по адресу и открывал перебор всех остальных.
  throttle.reset(`login:user:${username.toLowerCase()}`)

  // Пароль верный, но правилам стойкости больше не соответствует.
  //
  // Требования к паролю ужесточаются со временем, а хеш в базе не говорит
  // о самом пароле ничего — проверить его можно ровно в одном месте и ровно
  // один раз: здесь, в момент, когда открытый текст в руках. Отказать во входе
  // нельзя (человек не сможет ни войти, ни сменить пароль), поэтому помечаем
  // учётку так же, как помечен временный пароль: панель пустит внутрь только
  // через форму смены.
  if (!validatePasswordStrength(password, user.username).ok && user.must_change_password !== 1) {
    db.run('UPDATE users SET must_change_password = 1, updated_at = ? WHERE id = ?', [
      startedAt,
      user.id,
    ])
    user.must_change_password = 1
    audit(db, {
      at: startedAt,
      userId: user.id,
      actor: user.username,
      action: 'password.weak_detected',
      entity: 'user',
      entityId: String(user.id),
      ipHash,
      // Ни пароля, ни причины отказа: код проверки подсказывает, чего именно
      // в пароле не хватает, а журнал читают из панели и выгружают в бэкап.
      diff: { mustChangePassword: true },
    })
  }

  // Пароля одного НЕДОСТАТОЧНО, если учётка требует второй фактор — независимо
  // от того, привязано приложение или ещё нет.
  //
  // Раньше здесь стояло `Boolean(totp)`: учётка с totp_required = 1 и ещё
  // не подтверждённым секретом получала полноценную сессию, а на привязку
  // её уводил только интерфейс. То есть защита держалась на клиенте: любой,
  // у кого есть пароль, мог не открывать панель вовсе и сразу читать
  // /api/admin/leads с телефонами клиентов. Теперь такая сессия ограничена
  // на сервере и не даёт ничего, кроме привязки.
  const totp = db.get(SQL_TOTP_SECRET, [user.id])
  const needsTotp = user.totp_required === 1

  const created = createSession(db, {
    userId: user.id,
    state: needsTotp ? 'pending_totp' : 'active',
    ip,
    ua,
    amr: 'pwd',
    now: startedAt,
    // Срок зависит от того, есть ли уже привязка: ввести готовый код — минуты,
    // пройти привязку с нуля — заметно дольше (см. ENROLL_TTL_MS).
    idleMs: needsTotp ? (totp ? PENDING_TTL_MS : ENROLL_TTL_MS) : config.sessionIdleMs,
    // absoluteMs НЕ переопределяем даже для промежуточной сессии:
    // rotateSession наследует абсолютный срок от старой строки, и пять минут
    // уехали бы в полноценную сессию как её потолок жизни.
  })

  const csrfToken = bindCsrf(db, created.session, created.token)
  res.setHeader('Set-Cookie', sessionCookie(created.token))

  recordAttempt(db, { at: startedAt, username: user.username, ipHash, stage: 'password', outcome: 'ok' })
  audit(db, {
    at: startedAt,
    userId: user.id,
    actor: user.username,
    action: 'login.password',
    entity: 'session',
    entityId: created.session.id,
    ipHash,
    diff: { stage: needsTotp ? 'totp' : 'active' },
  })

  // Успех выравниваем тем же полом: иначе верный пароль отличался бы от
  // неверного длительностью ответа ещё до того, как клиент увидит тело.
  await settleAt(startedAt, SETTLE_FLOOR_MS)

  if (needsTotp) {
    // csrfToken отдаём уже здесь, хотя стадия неполная: следующий шаг
    // (/session/totp либо /2fa/setup) — мутация, и без токена он не прошёл бы
    // verifyCsrf.
    //
    // Стадии две, и они означают разное: 'totp' — приложение привязано, введи
    // код; 'enroll' — привязки ещё нет, пройди её. Обе одинаково ограничены
    // на сервере, но интерфейсу нужно знать, какой экран показать.
    json(res, 200, {
      ok: true,
      stage: totp ? 'totp' : 'enroll',
      csrfToken,
      expiresAt: expiresAt(created.session),
      attemptsLeft: MAX_TOTP_ATTEMPTS,
    })
    return
  }

  json(res, 200, {
    ok: true,
    stage: 'active',
    csrfToken,
    totpEnrolled: Boolean(totp),
    ...sessionView(user, created.session),
  })
}

// ---------------------------------------------------------------------------
// Второй фактор: общая часть
// ---------------------------------------------------------------------------

/**
 * Отказ на шаге второго фактора. Считает попытки по промежуточной сессии
 * и уничтожает её на MAX_TOTP_ATTEMPTS-й неудаче.
 */
const rejectSecondFactor = async (ctx, params) => {
  const { db, escalation } = ctx
  const { res, startedAt, session, user, stage, outcome, ipHash } = params

  const attempts = session.totp_attempts + 1
  const destroyed = attempts >= MAX_TOTP_ATTEMPTS

  if (destroyed) {
    revokeSession(db, session, { reason: 'totp_failed', now: startedAt })
    res.setHeader('Set-Cookie', clearSessionCookie())
  } else {
    db.run('UPDATE sessions SET totp_attempts = ? WHERE id = ?', [attempts, session.id])
  }

  recordAttempt(db, { at: startedAt, username: user.username, ipHash, stage, outcome })
  // Второй фактор перебирают с того же адреса и теми же средствами, что
  // и пароль, поэтому счётчик адреса общий: пять кодов на промежуточную
  // сессию обходятся повторным входом, а вот адресный порог — нет.
  escalateFailure(escalation, {
    ipHash,
    username: user.username,
    stage,
    outcome,
    now: startedAt,
  })
  audit(db, {
    at: startedAt,
    userId: user.id,
    actor: user.username,
    action: destroyed ? 'login.2fa_destroyed' : 'login.2fa_denied',
    entity: 'session',
    entityId: session.id,
    ipHash,
    diff: { stage, outcome, attempts },
    result: 'denied',
  })

  await settleAt(startedAt, SETTLE_FLOOR_MS + progressiveDelayMs(attempts))

  // Факт уничтожения сессии не скрываем: держатель промежуточной сессии
  // и так знает всё, что мог бы узнать, а без этого признака интерфейс
  // предлагал бы вводить код в мёртвую форму.
  json(res, 401, {
    ok: false,
    error: destroyed ? 'session_destroyed' : 'invalid_code',
    attemptsLeft: destroyed ? 0 : MAX_TOTP_ATTEMPTS - attempts,
  })
}

/** Общий хвост удачного второго фактора: ротация, кука, ответ. */
const completeSecondFactor = (ctx, params) => {
  const { db } = ctx
  const { res, startedAt, session, user, amr, ipHash, action, extra } = params

  // Ротация ОБЯЗАТЕЛЬНА: это защита от фиксации сессии. Идентификатор,
  // который атакующий мог навязать браузеру до входа, обязан перестать
  // действовать ровно в момент, когда прав у сессии прибавилось.
  const rotated = rotateSession(db, session, {
    state: 'active',
    amr,
    now: startedAt,
    idleMs: config.sessionIdleMs,
    reauthAt: startedAt,
  })

  const csrfToken = bindCsrf(db, rotated.session, rotated.token)
  res.setHeader('Set-Cookie', sessionCookie(rotated.token))

  audit(db, {
    at: startedAt,
    userId: user.id,
    actor: user.username,
    action,
    entity: 'session',
    entityId: rotated.session.id,
    ipHash,
  })

  json(res, 200, {
    ok: true,
    stage: 'active',
    csrfToken,
    ...sessionView(user, rotated.session),
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/session/totp
// ---------------------------------------------------------------------------

const totpHandler = (ctx) => async (req, res) => {
  const { db } = ctx
  const startedAt = Date.now()

  // Только промежуточная сессия: полноценная здесь делать нечего, а её
  // владелец второй фактор уже прошёл.
  const access = requireSession(db, req, { state: 'pending_totp', now: startedAt })
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return
  }
  if (!csrfPassed(req, res, access.session)) return

  const body = await readBody(req, res)
  if (!body) return

  const { session, user } = access
  const { ipHash } = ensureRequestContext(req)
  const row = loadTotpSecret(db, user.id)

  const result = row
    ? verifyTotp(row.secret, asString(body.code), {
      timeMs: startedAt,
      digits: row.digits,
      period: row.period,
      algorithm: row.algorithm,
      lastUsedStep: row.last_used_step,
    })
    : { ok: false, reason: 'no_secret' }

  if (!result.ok) {
    await rejectSecondFactor(ctx, {
      res,
      startedAt,
      session,
      user,
      stage: 'totp',
      outcome: 'bad_totp',
      ipHash,
    })
    return
  }

  // Шаг записываем ДО выдачи прав: тот же код, подсмотренный в течение своих
  // 30 секунд, второй раз не пройдёт (RFC 6238 §5.2).
  db.run('UPDATE totp_secrets SET last_used_step = ? WHERE user_id = ?', [
    result.matchedStep,
    user.id,
  ])
  recordAttempt(db, { at: startedAt, username: user.username, ipHash, stage: 'totp', outcome: 'ok' })

  completeSecondFactor(ctx, {
    res,
    startedAt,
    session,
    user,
    amr: 'pwd,otp',
    ipHash,
    action: 'login.totp',
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/session/recovery
// ---------------------------------------------------------------------------

const recoveryHandler = (ctx) => async (req, res) => {
  const { db } = ctx
  const startedAt = Date.now()

  const access = requireSession(db, req, { state: 'pending_totp', now: startedAt })
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return
  }
  if (!csrfPassed(req, res, access.session)) return

  const body = await readBody(req, res)
  if (!body) return

  const { session, user } = access
  const { ipHash } = ensureRequestContext(req)
  // Проверку делает admin.2fa.js — тот же модуль, который коды выдаёт.
  //
  // Здесь раньше жила вторая, несовместимая реализация: выдача хешировала
  // код через scrypt, а этот поиск искал HMAC-SHA256 по точному совпадению.
  // Расходилась и канонизация (с дефисом и заменой I/L/O против без них).
  // Совпасть они не могли никогда, то есть НИ ОДИН код восстановления
  // не работал: потерявший телефон владелец получал bad_recovery, сжигал
  // пять попыток и оставался заперт до вмешательства через SSH.
  const consumed = await consumeRecoveryCode(db, user.id, body.code, {
    ipHash,
    now: startedAt,
  })

  if (!consumed.ok) {
    await rejectSecondFactor(ctx, {
      res,
      startedAt,
      session,
      user,
      stage: 'recovery',
      outcome: 'bad_recovery',
      ipHash,
    })
    return
  }

  const remaining = consumed.remaining
  recordAttempt(db, {
    at: startedAt,
    username: user.username,
    ipHash,
    stage: 'recovery',
    outcome: 'ok',
  })

  // amr фиксирует, что второго фактора как такового не было: вход по
  // бумажному коду — не то же самое, что код из приложения, и операции,
  // которым нужен настоящий 2FA, смогут это увидеть.
  completeSecondFactor(ctx, {
    res,
    startedAt,
    session,
    user,
    amr: 'pwd,recovery',
    ipHash,
    action: 'login.recovery',
    extra: { remaining },
  })
}

// ---------------------------------------------------------------------------
// GET /api/admin/session
// ---------------------------------------------------------------------------

const currentSessionHandler = ({ db }) => async (req, res) => {
  // Минимальная информация о текущей сессии нужна экрану обязательной смены
  // пароля. Остальные requireActive-вызовы закрыты серверным password gate.
  const access = requireActive(db, req, { allowPasswordChangePending: true })
  if (!access.ok) {
    // Незавершённый вход (пароль принят, второго фактора ещё нет) нужно уметь
    // продолжить после перезагрузки страницы: без стадии и CSRF-токена
    // человек, обновивший вкладку посреди привязки, оказывался бы в тупике —
    // сессия жива, но интерфейс о ней ничего не знает.
    const pending = requireSession(db, req, { state: 'pending_totp' })
    if (pending.ok) {
      const totp = db.get(SQL_TOTP_SECRET, [pending.session.user_id])
      json(res, 200, {
        ok: true,
        authenticated: false,
        stage: totp ? 'totp' : 'enroll',
        csrfToken: csrfFor(db, pending.session, pending.token),
        expiresAt: expiresAt(pending.session),
      })
      return
    }

    // Сюда запрос доходит, только если гейт уже пройден (проверка стоит выше,
    // в server/app.js), то есть панель этому клиенту показывать можно.
    // Отвечаем «панель есть, вы не вошли» — по этому ответу интерфейс рисует
    // форму входа. Маскировку это не ослабляет: без гейта запрос до сюда
    // не доходит и получает такой же 404, как несуществующий /api/*.
    json(res, 200, { ok: true, authenticated: false })
    return
  }

  const { session, user, token } = access

  json(res, 200, {
    ok: true,
    csrfToken: csrfFor(db, session, token),
    reauthAt: session.reauth_at,
    ...sessionView(user, session),
  })
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/session — выход
// ---------------------------------------------------------------------------

const logoutHandler = ({ db }) => async (req, res) => {
  const now = Date.now()
  // Без требования к состоянию: брошенный на полпути вход тоже надо уметь
  // закрыть, не дожидаясь пяти минут.
  const access = requireSession(db, req, { now })
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return
  }
  // contentTypes: null — у DELETE нет тела, а значит нет и Content-Type,
  // и третий барьер здесь просто нечему проверять. Он и не нужен: HTML-форма
  // метод DELETE отправить не умеет в принципе, барьеры Origin и токена целы.
  if (!csrfPassed(req, res, access.session, { contentTypes: null })) return

  revokeSession(db, access.session, { reason: 'logout', now })
  res.setHeader('Set-Cookie', clearSessionCookie())

  audit(db, {
    at: now,
    userId: access.user.id,
    actor: access.user.username,
    action: 'logout',
    entity: 'session',
    entityId: access.session.id,
    ipHash: ensureRequestContext(req).ipHash,
  })

  json(res, 200, { ok: true })
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/sessions — выход на всех устройствах
// ---------------------------------------------------------------------------

const logoutAllHandler = ({ db }) => async (req, res) => {
  const now = Date.now()
  const access = requireActive(db, req, { now })
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return
  }
  if (!csrfPassed(req, res, access.session, { contentTypes: null })) return

  // Текущую сессию тоже: человек нажимает «выйти везде» именно тогда, когда
  // не уверен, что его устройство единственное скомпрометированное.
  const revoked = revokeAllForUser(db, access.user.id, { reason: 'logout_all', now })
  res.setHeader('Set-Cookie', clearSessionCookie())

  audit(db, {
    at: now,
    userId: access.user.id,
    actor: access.user.username,
    action: 'logout.all',
    entity: 'user',
    entityId: String(access.user.id),
    ipHash: ensureRequestContext(req).ipHash,
    diff: { revoked },
  })

  json(res, 200, { ok: true, revoked })
}

// ---------------------------------------------------------------------------
// POST /api/admin/password — смена пароля
// ---------------------------------------------------------------------------

const passwordHandler = ({ db, throttle }) => async (req, res) => {
  const startedAt = Date.now()

  // Сессия с must_change_password сюда попасть ОБЯЗАНА: это единственный
  // маршрут, доступный до смены временного пароля.
  const access = requireActive(db, req, {
    now: startedAt,
    allowPasswordChangePending: true,
  })
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return
  }
  if (!csrfPassed(req, res, access.session)) return

  const body = await readBody(req, res)
  if (!body) return

  const { session, user } = access
  const { ipHash } = ensureRequestContext(req)
  const current = asString(body.current)
  const next = asString(body.next)

  const limit = throttle.hit(`reauth:user:${user.id}`, {
    windowMs: REAUTH_WINDOW_MS,
    max: REAUTH_MAX,
    now: startedAt,
  })
  if (!limit.allowed) {
    await settleAt(startedAt, SETTLE_FLOOR_MS)
    tooManyRequests(res, limit.resetAt, startedAt)
    return
  }

  const strength = validatePasswordStrength(next, user.username)
  if (!strength.ok) {
    // Слабый пароль — ошибка ввода, а не попытка подбора: отвечаем сразу
    // и по делу, скрывать здесь нечего.
    json(res, 400, { ok: false, error: strength.error })
    return
  }

  const stored = db.get(SQL_PASSWORD_HASH, [user.id])?.password_hash ?? DECOY_HASH
  const currentOk = await verifyPassword(current, stored)

  if (!currentOk) {
    audit(db, {
      at: startedAt,
      userId: user.id,
      actor: user.username,
      action: 'password.denied',
      entity: 'user',
      entityId: String(user.id),
      ipHash,
      diff: { reason: 'bad_current' },
      result: 'denied',
    })
    await settleAt(startedAt, SETTLE_FLOOR_MS + progressiveDelayMs(limit.count))
    json(res, 401, { ok: false, error: 'invalid_credentials' })
    return
  }

  if (next === current) {
    json(res, 400, { ok: false, error: 'password_unchanged' })
    return
  }

  const hash = await hashPassword(next)
  const now = Date.now()

  db.run(
    `UPDATE users
        SET password_hash = ?, password_changed_at = ?, must_change_password = 0,
            failed_attempts = 0, lock_level = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?`,
    [hash, now, now, user.id]
  )

  // Сначала ротация текущей сессии (новый токен взамен того, что мог утечь
  // вместе со старым паролем), потом отзыв всех остальных. Порядок важен:
  // revokeAllForUser исключает ровно один id, и это должен быть id УЖЕ новой
  // строки, иначе человек разлогинит сам себя вместе с чужими устройствами.
  const rotated = rotateSession(db, session, {
    state: 'active',
    now,
    idleMs: config.sessionIdleMs,
    reauthAt: now,
    reason: 'password_change',
  })
  const revoked = revokeAllForUser(db, user.id, {
    reason: 'password_change',
    now,
    exceptId: rotated.session.id,
  })

  const csrfToken = bindCsrf(db, rotated.session, rotated.token)
  res.setHeader('Set-Cookie', sessionCookie(rotated.token))

  audit(db, {
    at: now,
    userId: user.id,
    actor: user.username,
    action: 'password.change',
    entity: 'user',
    entityId: String(user.id),
    ipHash,
    // В diff уходит только факт: ни старого, ни нового пароля, ни их хешей.
    diff: { revokedSessions: revoked },
  })

  json(res, 200, {
    ok: true,
    csrfToken,
    revokedSessions: revoked,
    ...sessionView({ ...user, must_change_password: 0 }, rotated.session),
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/reauth — повторное подтверждение пароля
// ---------------------------------------------------------------------------

const reauthHandler = ({ db, throttle }) => async (req, res) => {
  const startedAt = Date.now()

  const access = requireActive(db, req, { now: startedAt })
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return
  }
  if (!csrfPassed(req, res, access.session)) return

  const body = await readBody(req, res)
  if (!body) return

  const { session, user } = access
  const { ipHash } = ensureRequestContext(req)

  const limit = throttle.hit(`reauth:user:${user.id}`, {
    windowMs: REAUTH_WINDOW_MS,
    max: REAUTH_MAX,
    now: startedAt,
  })
  if (!limit.allowed) {
    await settleAt(startedAt, SETTLE_FLOOR_MS)
    tooManyRequests(res, limit.resetAt, startedAt)
    return
  }

  const stored = db.get(SQL_PASSWORD_HASH, [user.id])?.password_hash ?? DECOY_HASH
  const ok = await verifyPassword(asString(body.password), stored)

  if (!ok) {
    audit(db, {
      at: startedAt,
      userId: user.id,
      actor: user.username,
      action: 'reauth.denied',
      entity: 'session',
      entityId: session.id,
      ipHash,
      result: 'denied',
    })
    await settleAt(startedAt, SETTLE_FLOOR_MS + progressiveDelayMs(limit.count))
    json(res, 401, { ok: false, error: 'invalid_credentials' })
    return
  }

  const now = Date.now()
  // Ротации здесь нет намеренно: уровень доверия не повышается, сессия та же,
  // просто у неё обновилась отметка «пароль подтверждали вот сейчас».
  db.run('UPDATE sessions SET reauth_at = ? WHERE id = ?', [now, session.id])
  session.reauth_at = now

  audit(db, {
    at: now,
    userId: user.id,
    actor: user.username,
    action: 'reauth.ok',
    entity: 'session',
    entityId: session.id,
    ipHash,
  })

  await settleAt(startedAt, SETTLE_FLOOR_MS)
  json(res, 200, { ok: true, reauthAt: now })
}

// ---------------------------------------------------------------------------
// Регистрация маршрутов
// ---------------------------------------------------------------------------

/**
 * Вешает маршруты входа на роутер API.
 *
 * @param {{register: Function}} router роутер из server/router.js
 * @param {{db: object, throttle?: object}} deps
 *   db — соединение из server/db/index.js;
 *   throttle — лимитер из server/lib/ratelimit.js. Необязателен: по умолчанию
 *   создаётся поверх того же соединения. Внедряется ради тестов, которым нужно
 *   подменить время окна.
 *   escalation — модуль из server/auth/throttle.js. Тоже необязателен;
 *   внедряется в тестах, которым нужны свои пороги блокировки.
 */
export const registerAdminAuthRoutes = (router, deps = {}) => {
  const { db, throttle, escalation } = deps
  if (!db) throw new TypeError('admin.auth: нужен deps.db')

  const ctx = {
    db,
    throttle: throttle ?? createRateLimiter(db),
    escalation: escalation ?? createThrottle(db),
  }

  router.register('POST', '/api/admin/session', loginHandler(ctx))
  router.register('POST', '/api/admin/session/totp', totpHandler(ctx))
  router.register('POST', '/api/admin/session/recovery', recoveryHandler(ctx))
  router.register('GET', '/api/admin/session', currentSessionHandler(ctx))
  router.register('DELETE', '/api/admin/session', logoutHandler(ctx))
  router.register('DELETE', '/api/admin/sessions', logoutAllHandler(ctx))
  router.register('POST', '/api/admin/password', passwordHandler(ctx))
  router.register('POST', '/api/admin/reauth', reauthHandler(ctx))

  return router
}
