// Второй фактор админки: привязка TOTP, коды восстановления, снятие 2FA.
//
// ГЛАВНЫЙ ИНВАРИАНТ ФАЙЛА. В totp_secrets лежит ТОЛЬКО действующий фактор.
// Кандидат в секреты живёт в отдельной таблице totp_pending и не виден ни
// маршруту входа, ни loadConfirmedTotp() — то есть подтвердить его можно,
// а войти по нему нельзя.
//
// Раньше кандидат писался прямо в totp_secrets с confirmed_at = NULL, и это
// ломало ровно то, что должно было защищать: строка на пользователя одна,
// поэтому UPSERT затирал РАБОЧИЙ секрет ещё до проверки нового кода. Брошенная
// перепривязка (закрыли вкладку, приложение не сохранило запись, телефон сел)
// оставляла аккаунт с одним паролем, а старая запись в аутентификаторе уже
// не подходила. Теперь подмена происходит одной транзакцией в момент confirm:
// до неё старый фактор работает, после — работает только новый.
//
// ЧТО ЛЕЖИТ В БАЗЕ:
//   - секрет TOTP — только зашифрованным (secretbox, PURPOSE.totpSecret),
//     тремя колонками ct/iv/tag: дамп app.sqlite без APP_SECRET не даёт
//     возможности считать чужие коды. Это верно для обеих таблиц;
//   - коды восстановления — только scrypt-хешами: утёкшая база не должна
//     давать вход в обход второго фактора.
//
// ВСЁ СОСТОЯНИЕ В SQLITE. Passenger держит пул процессов, поэтому «сколько
// осталось попыток», «какой шаг времени уже использован» и «погашен ли код»
// живут в базе, а погашение кода — это UPDATE с условием used_at IS NULL
// и проверкой числа изменённых строк, а не пара SELECT + UPDATE.

import { verifyCsrf } from '../auth/csrf.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import {
  loadSession,
  readSessionToken,
  revokeAllForUser,
  rotateSession,
  sessionCookie,
  touchSession,
} from '../auth/session.js'
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  buildOtpauthUri,
  generateRecoveryCodes,
  generateSecret,
  verifyTotp,
} from '../auth/totp.js'
import { config } from '../config.js'
import { PURPOSE, open, seal } from '../crypto/secretbox.js'
import { readJson } from '../http/body.js'
import { json, uniform404 } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import { ACCOUNT_STATE, accountStateOf } from '../policies/account-state.js'
import { settleAt } from '../lib/timing.js'

// Сколько живёт подтверждение пароля. Все операции этого файла меняют то,
// чем защищён аккаунт, поэтому одной живой сессии мало: угнанная вкладка
// не должна уметь перепривязать второй фактор на чужой телефон.
export const REAUTH_MAX_AGE_MS = 10 * 60_000

// Ровно столько кодов выдаётся за раз. Меньше — человек упрётся в «коды
// кончились» в самый неподходящий момент, больше — распечатка перестаёт
// помещаться в бумажник и оседает файлом на рабочем столе.
export const RECOVERY_CODE_COUNT = 10

// Сколько живёт выданный, но не подтверждённый секрет.
//
// Двадцать минут — это ровно ENROLL_TTL_MS из server/routes/admin.auth.js:
// окно, отведённое на первичную привязку (найти приложение в магазине,
// установить, выдать доступ к камере, отсканировать). Значение продублировано
// намеренно, а не импортировано: admin.auth.js уже импортирует этот модуль
// ради consumeRecoveryCode, и обратный импорт замкнул бы цикл. При изменении
// одного менять оба.
//
// Срок отдельный от срока сессии: полноценная сессия живёт часами и
// продлевается запросами, а секрет, показанный на экране и забытый, не должен
// оставаться подтверждаемым до конца рабочего дня.
export const SETUP_TTL_MS = 20 * 60_000

// В телах этих маршрутов бывает только { code: 'XXXXXX' }. Килобайта хватает
// с запасом, а всё, что больше, читать незачем.
const BODY_LIMIT = 1024

// Подбор шестизначного кода из уже авторизованной сессии — сценарий редкий,
// но дешёвый для атакующего: 10 попыток за 5 минут делают его бессмысленным,
// а живому человеку столько не нужно (код меняется раз в 30 секунд).
const CONFIRM_WINDOW_MS = 5 * 60_000
const CONFIRM_MAX = 10

// Код восстановления — это разовый пароль на 50 бит. Пять попыток за четверть
// часа: перебор невозможен, а человек, путающий 0 и O, успеет исправиться.
const RECOVERY_WINDOW_MS = 15 * 60_000
const RECOVERY_MAX = 5

// Пол длительности неудачного подтверждения. Проверка кода стоит микросекунды,
// и без выравнивания по времени ответа видно, дошло ли дело до сверки вообще.
const CONFIRM_FLOOR_MS = 200

const JSON_ONLY = Object.freeze(['application/json'])

// id пользователя из пути. Своя проверка, а не Number(): '01', '1e3' и '1.0'
// дают валидное число, но это уже не тот идентификатор, который написали
// в URL, — и в аудите останется не то, что происходило на самом деле.
const USER_ID_PATTERN = /^[1-9]\d{0,9}$/

const SQL_USER =
  'SELECT id, username, role, status, must_change_password FROM users WHERE id = ?'

const SQL_SECRET = 'SELECT * FROM totp_secrets WHERE user_id = ?'

const SQL_SECRET_STATE = 'SELECT confirmed_at FROM totp_secrets WHERE user_id = ?'

// Кандидат в секреты. Ключ — пара (пользователь, сессия привязки): повторный
// setup из той же вкладки заменяет свой же секрет, а параллельная привязка
// из другого браузера заводит собственную строку и чужую не трогает.
const SQL_UPSERT_PENDING = `
  INSERT INTO totp_pending (
    user_id, session_id, secret_ct, secret_iv, secret_tag,
    digits, period, algorithm, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, session_id) DO UPDATE SET
    secret_ct  = excluded.secret_ct,
    secret_iv  = excluded.secret_iv,
    secret_tag = excluded.secret_tag,
    digits     = excluded.digits,
    period     = excluded.period,
    algorithm  = excluded.algorithm,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at
`

const SQL_PENDING = `
  SELECT id, secret_ct, secret_iv, secret_tag, digits, period, algorithm, expires_at
    FROM totp_pending
   WHERE user_id = ? AND session_id = ?
`

// Гасить кандидата по id, а не по паре ключей: число изменённых строк здесь —
// это защита от двух одновременных confirm. Первый забирает строку, второй
// видит changes = 0 и получает отказ вместо второго комплекта кодов.
const SQL_DELETE_PENDING_ROW = 'DELETE FROM totp_pending WHERE id = ?'

const SQL_DELETE_PENDING_USER = 'DELETE FROM totp_pending WHERE user_id = ?'

const SQL_DELETE_PENDING_EXPIRED = `
  DELETE FROM totp_pending WHERE user_id = ? AND expires_at <= ?
`

// Подмена действующего фактора. Пишется ТОЛЬКО после успешной проверки кода:
// confirmed_at и last_used_step приходят готовыми, поэтому промежуточного
// состояния «секрет уже новый, но ещё не подтверждён» не существует вовсе.
// last_used_step берётся из подтверждающего кода — иначе тот же код прошёл бы
// ещё раз на входе.
const SQL_ACTIVATE_SECRET = `
  INSERT INTO totp_secrets (
    user_id, secret_ct, secret_iv, secret_tag,
    digits, period, algorithm, confirmed_at, last_used_step, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    secret_ct      = excluded.secret_ct,
    secret_iv      = excluded.secret_iv,
    secret_tag     = excluded.secret_tag,
    digits         = excluded.digits,
    period         = excluded.period,
    algorithm      = excluded.algorithm,
    confirmed_at   = excluded.confirmed_at,
    last_used_step = excluded.last_used_step,
    created_at     = excluded.created_at
`

const SQL_DELETE_SECRET = 'DELETE FROM totp_secrets WHERE user_id = ?'

// Анти-повтор для маршрута входа: шаг принимается только строго новее
// сохранённого, поэтому запись идёт с тем же условием, что и проверка.
const SQL_MARK_STEP = `
  UPDATE totp_secrets
     SET last_used_step = ?
   WHERE user_id = ?
     AND confirmed_at IS NOT NULL
     AND (last_used_step IS NULL OR last_used_step < ?)
`

const SQL_INSERT_CODE = `
  INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)
`

// Старые коды гасим, а не удаляем: в таблице должно остаться видно, что коды
// были и когда их вывели из обращения. Партиальный индекс по used_at IS NULL
// делает этот UPDATE и подсчёт остатка обращением к маленькому дереву.
const SQL_BURN_UNUSED = `
  UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL
`

const SQL_UNUSED_CODES = `
  SELECT id, code_hash FROM recovery_codes
   WHERE user_id = ? AND used_at IS NULL
   ORDER BY id
`

const SQL_REDEEM_CODE = `
  UPDATE recovery_codes
     SET used_at = ?, used_ip = ?
   WHERE id = ? AND used_at IS NULL
`

const SQL_COUNT_UNUSED = `
  SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL
`

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, ?, ?, ?, '2fa', ?, ?, ?, ?)
`

/**
 * Запись в журнал действий. actor дублирует username намеренно (см. схему):
 * пользователя когда-нибудь удалят, user_id обнулится, и без снимка имени
 * запись станет анонимной ровно там, где она нужнее всего.
 */
const audit = (db, entry) => {
  const {
    at = Date.now(),
    actorId,
    actor,
    action,
    entityId,
    ipHash = null,
    diff = null,
    result = 'ok',
  } = entry

  db.run(SQL_AUDIT, [
    at,
    actorId ?? null,
    actor,
    action,
    entityId == null ? null : String(entityId),
    ipHash,
    diff == null ? null : JSON.stringify(diff),
    result,
  ])
}

// Лимитер держит счётчики в той же базе (иначе пул процессов Passenger считал
// бы у каждого свои). Создаётся лениво и один раз на соединение: конструктор
// делает CREATE TABLE IF NOT EXISTS и prepare, и повторять это на каждый
// запрос незачем. WeakMap, чтобы закрытая в тестах база не удерживалась.
const limiters = new WeakMap()

const limiterFor = (db) => {
  let limiter = limiters.get(db)
  if (!limiter) {
    limiter = createRateLimiter(db)
    limiters.set(db, limiter)
  }
  return limiter
}

/**
 * Проверка доступа, общая для всех маршрутов файла.
 *
 * Любой отказ на уровне сессии отвечает НЕОТЛИЧИМО от несуществующего адреса
 * (uniform404): 401 или 403 подтвердили бы сканеру, что путь /api/admin/*
 * угадан, а вся защита админки держится на том, что этого не видно.
 * Отказы уже опознанному пользователю — наоборот, честный JSON: он вошёл,
 * и прятать от него причину бессмысленно.
 *
 * @returns {{session: object, user: object, ipHash: string} | null}
 *   null означает, что ответ уже отправлен и обработчику делать нечего.
 */
const authorize = async (db, req, res, contentTypes, options = {}) => {
  const loaded = loadSession(db, readSessionToken(req))
  // state='pending_totp' — это «пароль принят, второго фактора ещё нет».
  // Такая сессия не даёт ничего, кроме проверки кода, и уж точно не даёт
  // перевыпустить коды восстановления.
  //
  // Исключение ровно одно: сама привязка. Пользователь, которому выдали пароль
  // и потребовали второй фактор, обязан иметь возможность его подключить —
  // иначе учётка заперта наглухо. Поэтому setup и confirm принимают такую
  // сессию, но ТОЛЬКО пока подтверждённого секрета нет: иначе этот же путь
  // позволил бы перепривязать чужой аутентификатор, зная один пароль.
  if (!loaded.ok) {
    await uniform404(req, res)
    return null
  }

  if (loaded.session.state !== 'active') {
    const enrolling =
      options.allowEnrollment &&
      loaded.session.state === 'pending_totp' &&
      !db.get(SQL_SECRET_STATE, [loaded.session.user_id])?.confirmed_at

    if (!enrolling) {
      await uniform404(req, res)
      return null
    }
  }

  const session = loaded.session
  const user = db.get(SQL_USER, [session.user_id])
  if (!user || user.status !== 'active') {
    await uniform404(req, res)
    return null
  }

  // pending_totp выше разрешён только setup/confirm и остаётся рабочим:
  // без этого первый вход невозможно завершить. Но полноценная active-сессия
  // с временным паролем уже прошла нужный фактор и не должна перевыпускать
  // recovery-коды, перепривязывать или снимать чужой 2FA до смены пароля.
  if (accountStateOf({ user, session }) === ACCOUNT_STATE.pendingPasswordChange) {
    json(res, 403, { ok: false, error: 'must_change_password' })
    return null
  }

  const csrf = verifyCsrf(req, session, {
    publicOrigin: config.publicOrigin,
    contentTypes,
  })
  if (!csrf.ok) {
    // 415 отличается от 403 намеренно: неверный Content-Type — это ошибка
    // клиента, а не подозрение на подделку запроса, и отлаживать её иначе
    // пришлось бы наугад.
    const status = csrf.error === 'unsupported_media_type' ? 415 : 403
    json(res, status, { ok: false, error: csrf.error })
    return null
  }

  // Продление сессии само по себе троттлится (TOUCH_INTERVAL_MS), поэтому
  // вызов дешёвый: без него привязка второго фактора могла бы упереться
  // в истёкшее окно бездействия ровно посередине.
  touchSession(db, session)

  return { session, user, ipHash: ensureRequestContext(req).ipHash }
}

/**
 * Свежесть подтверждения пароля. Возвращает false и уже отправляет ответ,
 * если подтверждать нужно заново.
 *
 * @param {{exemptEnrollment?: boolean}} [options] снять требование для сессии
 *   pending_totp. Разрешено ТОЛЬКО там, где действующего фактора нет и терять
 *   нечего; по умолчанию исключения нет.
 */
const requireFreshReauth = (ctx, res, now, options = {}) => {
  // Первичная привязка — исключение. Сессия в состоянии pending_totp выдана
  // только что и только по паролю: пользователь ввёл его секунду назад, и
  // требовать подтвердить пароль ещё раз просто некуда — экрана для этого
  // на стадии привязки нет, а без исключения учётка запирается наглухо.
  //
  // Для ПОЛНОЦЕННОЙ сессии проверка остаётся: она живёт часами, и перепривязка
  // второго фактора с угнанной куки обязана упереться в пароль. Смена уже
  // работающего фактора не пользуется исключением вообще — второй фактор при
  // этом либо уже пройден (сессия active), либо предъявлять нечего.
  if (options.exemptEnrollment && ctx.session.state === 'pending_totp') return true

  const at = ctx.session.reauth_at
  const age = typeof at === 'number' ? now - at : Infinity

  // Отрицательный возраст (метка из будущего) считаем протухшим: часы могли
  // прыгнуть назад, и ошибаться нужно в сторону лишнего ввода пароля,
  // а не в сторону вечно свежего подтверждения.
  if (age >= 0 && age <= REAUTH_MAX_AGE_MS) return true

  json(res, 403, {
    ok: false,
    error: 'reauth_required',
    maxAgeSec: Math.floor(REAUTH_MAX_AGE_MS / 1000),
  })
  return false
}

/**
 * Учитывает попытку в общем счётчике. Возвращает false и отправляет 429,
 * если лимит исчерпан.
 */
const withinLimit = (db, res, bucket, { windowMs, max, now }) => {
  const result = limiterFor(db).hit(bucket, { windowMs, max, now })
  if (result.allowed) return true

  const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - now) / 1000))
  res.setHeader('Retry-After', String(retryAfterSec))
  json(res, 429, { ok: false, error: 'rate_limited', retryAfterSec })
  return false
}

/**
 * Тело у setup и recovery-codes не нужно, но вычитать его обязательно:
 * CSRF-барьер требует Content-Type: application/json, то есть клиент пришлёт
 * хотя бы '{}', а непрочитанный поток запроса остаётся в сокете и мешает
 * следующему запросу того же keep-alive-соединения.
 */
const drainBody = async (req) => {
  await readJson(req, { limit: BODY_LIMIT })
}

const parseUserId = (value) =>
  USER_ID_PATTERN.test(String(value ?? '')) ? Number(value) : null

/**
 * Хеши кодов восстановления. Строго последовательно: scrypt с текущими
 * параметрами берёт 32 МиБ на вызов, и Promise.all на десяти кодах разом
 * запросил бы треть гигабайта в процессе, которому на shared-хостинге столько
 * не дадут. Секунда на редкую операцию дешевле, чем OOM.
 */
const hashRecoveryCodes = async (codes) => {
  const hashes = []
  for (const code of codes) {
    hashes.push(await hashPassword(code))
  }
  return hashes
}

/**
 * Приводит введённый код к тому виду, в котором он хешировался: 'XXXXX-XXXXX'.
 * Разделители и регистр не значимы, а I, L и O в алфавите кодов отсутствуют
 * (см. RECOVERY_ALPHABET) — поэтому их можно однозначно трактовать как 1 и 0,
 * а не отказывать человеку, переписавшему код с бумаги.
 */
const normalizeRecoveryCode = (value) => {
  const clean = String(value ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[ILO]/g, (char) => (char === 'O' ? '0' : '1'))

  if (clean.length !== 10) return null
  return `${clean.slice(0, 5)}-${clean.slice(5)}`
}

// ---------------------------------------------------------------------------
// POST /api/admin/2fa/setup
// ---------------------------------------------------------------------------

/**
 * Выдаёт новый секрет-кандидат и ссылку otpauth:// для QR-кода.
 *
 * Секрет возвращается ОДИН РАЗ и только здесь: в базе он лежит зашифрованным,
 * и повторно показать его нельзя — можно только выпустить новый.
 *
 * ДЕЙСТВУЮЩИЙ ФАКТОР ЭТОТ МАРШРУТ НЕ ТРОГАЕТ. Кандидат ложится в totp_pending
 * и ждёт confirm; всё это время вход по старому коду работает как работал.
 * Брошенная перепривязка не стоит теперь ничего: истечёт срок кандидата, и
 * на аккаунте останется ровно то, что было.
 *
 * Смена уже работающего фактора требует подтверждения пароля не старше
 * REAUTH_MAX_AGE_MS поверх полноценной сессии (то есть второй фактор в ней
 * уже пройден). Исключение для pending_totp действует только при первичной
 * привязке, когда терять нечего.
 */
const handleSetup = async (db, req, res) => {
  const ctx = await authorize(db, req, res, JSON_ONLY, { allowEnrollment: true })
  if (!ctx) return

  await drainBody(req)

  const now = Date.now()
  const existing = db.get(SQL_SECRET_STATE, [ctx.user.id])
  const rebind = Boolean(existing && existing.confirmed_at != null)

  if (!requireFreshReauth(ctx, res, now, { exemptEnrollment: !rebind })) return

  const secret = generateSecret()
  // purpose берём из константы, а не пишем строкой по месту: опечатка в нём
  // не проявляется при записи вообще никак, а при чтении выглядит как
  // повреждённая база.
  const box = seal(secret, PURPOSE.totpSecret)
  const expiresAt = now + SETUP_TTL_MS

  db.transaction(() => {
    // Просроченные кандидаты этого же пользователя убираем заодно: сессии
    // живут долго, и без уборки в таблице копились бы мёртвые секреты.
    db.run(SQL_DELETE_PENDING_EXPIRED, [ctx.user.id, now])

    db.run(SQL_UPSERT_PENDING, [
      ctx.user.id,
      ctx.session.id,
      box.ct,
      box.iv,
      box.tag,
      DEFAULT_DIGITS,
      DEFAULT_PERIOD,
      DEFAULT_ALGORITHM,
      now,
      expiresAt,
    ])

    // Сам секрет в аудит не попадает никогда — только факт события. Флаг
    // rebind тут главное: попытка заменить подтверждённый второй фактор должна
    // бросаться в глаза в журнале.
    audit(db, {
      at: now,
      actorId: ctx.user.id,
      actor: ctx.user.username,
      action: '2fa.setup',
      entityId: ctx.user.id,
      ipHash: ctx.ipHash,
      diff: { rebind },
    })
  })

  json(res, 200, {
    ok: true,
    secret,
    uri: buildOtpauthUri({
      secret,
      account: ctx.user.username,
      digits: DEFAULT_DIGITS,
      period: DEFAULT_PERIOD,
      algorithm: DEFAULT_ALGORITHM,
    }),
    digits: DEFAULT_DIGITS,
    period: DEFAULT_PERIOD,
    algorithm: DEFAULT_ALGORITHM,
    rebind,
    expiresAt,
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/2fa/confirm
// ---------------------------------------------------------------------------

/**
 * Подтверждает привязку кодом из приложения и выдаёт коды восстановления.
 *
 * ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ МЕНЯЕТСЯ ДЕЙСТВУЮЩИЙ ФАКТОР. Одна транзакция забирает
 * кандидата, ставит его секрет активным, гасит старые коды восстановления,
 * выдаёт новые, отзывает остальные сессии пользователя и пишет событие. Любой
 * сбой внутри откатывает всё: прежний секрет остаётся рабочим, а клиент видит
 * ошибку и может повторить привязку.
 *
 * Коды показываются РОВНО ОДИН РАЗ: в базе только их scrypt-хеши, повторно
 * достать их неоткуда. Потерявший распечатку перевыпускает набор целиком
 * (POST /api/admin/2fa/recovery-codes).
 */
const handleConfirm = async (db, req, res) => {
  const startedAt = Date.now()

  const ctx = await authorize(db, req, res, JSON_ONLY, { allowEnrollment: true })
  if (!ctx) return

  const body = await readJson(req, { limit: BODY_LIMIT })
  if (!body.ok) {
    json(res, body.error === 'payload_too_large' ? 413 : 400, {
      ok: false,
      error: body.error,
    })
    return
  }

  const now = Date.now()
  const active = db.get(SQL_SECRET_STATE, [ctx.user.id])
  const rebind = Boolean(active && active.confirmed_at != null)

  if (!requireFreshReauth(ctx, res, now, { exemptEnrollment: !rebind })) return
  if (!withinLimit(db, res, `2fa-confirm:${ctx.user.id}`, {
    windowMs: CONFIRM_WINDOW_MS,
    max: CONFIRM_MAX,
    now,
  })) return

  // Кандидат ищется по паре (пользователь, сессия): подтвердить можно только
  // тот секрет, который показали этой же вкладке. Иначе параллельная привязка
  // из другого браузера завершалась бы кодом от чужого QR.
  const pending = db.get(SQL_PENDING, [ctx.user.id, ctx.session.id])
  if (!pending) {
    json(res, 409, { ok: false, error: 'totp_not_started' })
    return
  }
  if (pending.expires_at <= now) {
    // Просроченного кандидата убираем сразу: держать его до следующего setup
    // незачем, а строка в таблице выглядела бы как незавершённая привязка.
    db.run(SQL_DELETE_PENDING_ROW, [pending.id])
    audit(db, {
      at: now,
      actorId: ctx.user.id,
      actor: ctx.user.username,
      action: '2fa.confirm',
      entityId: ctx.user.id,
      ipHash: ctx.ipHash,
      diff: { reason: 'expired' },
      result: 'denied',
    })
    json(res, 409, { ok: false, error: 'totp_setup_expired' })
    return
  }

  let secret
  try {
    secret = open(
      { ct: pending.secret_ct, iv: pending.secret_iv, tag: pending.secret_tag },
      PURPOSE.totpSecret
    )
  } catch (error) {
    // Расшифровка не удалась — сменили APP_SECRET либо повреждена строка.
    // Клиенту тут помочь нечем, но сообщение в лог обязано быть внятным:
    // снаружи это выглядит как «правильный код не принимается».
    console.error(`[2fa] секрет пользователя ${ctx.user.id} не читается: ${error.message}`)
    json(res, 500, { ok: false, error: 'totp_secret_unreadable' })
    return
  }

  // lastUsedStep не передаём: шаг из totp_secrets относится к ДРУГОМУ секрету,
  // и переносить его на кандидата означало бы отвергать его первые коды
  // по причине, к нему не относящейся.
  const check = verifyTotp(secret, body.value.code, {
    timeMs: now,
    digits: pending.digits,
    period: pending.period,
    algorithm: pending.algorithm,
  })

  if (!check.ok) {
    audit(db, {
      at: now,
      actorId: ctx.user.id,
      actor: ctx.user.username,
      action: '2fa.confirm',
      entityId: ctx.user.id,
      ipHash: ctx.ipHash,
      diff: { reason: check.reason },
      result: 'denied',
    })
    await settleAt(startedAt, CONFIRM_FLOOR_MS)
    json(res, 400, { ok: false, error: 'bad_totp', reason: check.reason })
    return
  }

  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT)
  // Хеши считаем ДО транзакции: scrypt занимает около секунды на десять кодов,
  // и держать это время открытой блокировку записи означало бы подвесить
  // остальные процессы пула на ровном месте.
  const hashes = await hashRecoveryCodes(codes)
  const confirmedAt = Date.now()

  let applied
  try {
    applied = db.transaction(() => {
      // Кандидата забираем ПЕРВЫМ действием, и число изменённых строк здесь —
      // это защита от двух одновременных confirm: второй увидит 0 и уйдёт
      // с 409, вместо того чтобы выдать второй комплект кодов.
      if (!db.run(SQL_DELETE_PENDING_ROW, [pending.id]).changes) return false

      db.run(SQL_ACTIVATE_SECRET, [
        ctx.user.id,
        pending.secret_ct,
        pending.secret_iv,
        pending.secret_tag,
        pending.digits,
        pending.period,
        pending.algorithm,
        confirmedAt,
        check.matchedStep,
        confirmedAt,
      ])

      // Кандидаты из других вкладок теряют смысл: фактор уже сменился, и
      // подтверждать их значило бы менять его ещё раз втихую.
      db.run(SQL_DELETE_PENDING_USER, [ctx.user.id])

      // Незакрытые коды от прошлой привязки: секрет сменился, и старый набор
      // больше не относится ни к чему.
      db.run(SQL_BURN_UNUSED, [confirmedAt, ctx.user.id])
      for (const hash of hashes) {
        db.run(SQL_INSERT_CODE, [ctx.user.id, hash, confirmedAt])
      }

      // Остальные сессии выданы ДО смены фактора — в том числе те, что мог
      // открыть тот, кто и вынудил владельца перепривязываться. Текущую
      // оставляем: иначе подтверждение привязки разлогинивало бы самого себя
      // прямо перед показом кодов восстановления.
      const revokedSessions = revokeAllForUser(db, ctx.user.id, {
        reason: 'logout_all',
        now: confirmedAt,
        exceptId: ctx.session.id,
      })

      audit(db, {
        at: confirmedAt,
        actorId: ctx.user.id,
        actor: ctx.user.username,
        action: '2fa.confirm',
        entityId: ctx.user.id,
        ipHash: ctx.ipHash,
        // Ни секрета, ни самих кодов — только их количество и факт замены.
        diff: { rebind, recoveryCodes: hashes.length, revokedSessions },
      })
      return true
    })
  } catch (error) {
    // Транзакция откатилась целиком: действующий фактор, коды восстановления
    // и сессии остались прежними. Кандидат тоже уцелел, поэтому повторный
    // confirm тем же кодом штатно доводит привязку до конца.
    console.error(`[2fa] подмена фактора пользователя ${ctx.user.id} не удалась: ${error.message}`)
    json(res, 500, { ok: false, error: 'totp_swap_failed' })
    return
  }

  if (!applied) {
    json(res, 409, { ok: false, error: 'totp_already_enabled' })
    return
  }

  // Привязка завершена — повышаем ограниченную сессию до полноценной.
  // Без этого пользователь, которому только что выдали пароль, оставался бы
  // в состоянии pending_totp и не мог ничего, кроме привязки, которую уже
  // прошёл. Ротация здесь ещё и правильна по безопасности: идентификатор,
  // выданный до подтверждения фактора, дальше не действует.
  if (ctx.session.state !== 'active') {
    const rotated = rotateSession(db, ctx.session, {
      state: 'active',
      amr: 'pwd+totp',
      now: confirmedAt,
    })
    if (rotated?.token) {
      res.setHeader('Set-Cookie', sessionCookie(rotated.token))
      json(res, 200, { ok: true, recoveryCodes: codes, csrfToken: rotated.csrfToken })
      return
    }
  }

  json(res, 200, { ok: true, recoveryCodes: codes })
}

// ---------------------------------------------------------------------------
// POST /api/admin/2fa/recovery-codes
// ---------------------------------------------------------------------------

/**
 * Перевыпуск кодов восстановления. Старые гасятся тем же временем, каким
 * созданы новые: набор всегда ровно один, а «использован» вместо «удалён»
 * оставляет в журнале след того, что коды были.
 */
const handleReissue = async (db, req, res) => {
  const ctx = await authorize(db, req, res, JSON_ONLY)
  if (!ctx) return

  await drainBody(req)

  const now = Date.now()
  if (!requireFreshReauth(ctx, res, now)) return

  const state = db.get(SQL_SECRET_STATE, [ctx.user.id])
  // Коды восстановления — это обход второго фактора. Пока фактора нет,
  // обходить нечего, а выданный набор был бы просто вторым паролем.
  if (!state || state.confirmed_at == null) {
    json(res, 409, { ok: false, error: 'totp_not_enabled' })
    return
  }

  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT)
  const hashes = await hashRecoveryCodes(codes)
  const issuedAt = Date.now()

  const applied = db.transaction(() => {
    // Состояние перечитываем внутри транзакции: пока считались хеши, владелец
    // мог снять привязку, и выдавать коды к несуществующему фактору нельзя.
    const fresh = db.get(SQL_SECRET_STATE, [ctx.user.id])
    if (!fresh || fresh.confirmed_at == null) return false

    const burned = db.run(SQL_BURN_UNUSED, [issuedAt, ctx.user.id]).changes
    for (const hash of hashes) {
      db.run(SQL_INSERT_CODE, [ctx.user.id, hash, issuedAt])
    }

    audit(db, {
      at: issuedAt,
      actorId: ctx.user.id,
      actor: ctx.user.username,
      action: '2fa.recovery_reissue',
      entityId: ctx.user.id,
      ipHash: ctx.ipHash,
      diff: { burned, issued: hashes.length },
    })
    return true
  })

  if (!applied) {
    json(res, 409, { ok: false, error: 'totp_not_enabled' })
    return
  }

  json(res, 200, { ok: true, recoveryCodes: codes })
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/2fa/:userId
// ---------------------------------------------------------------------------

/**
 * Снятие второго фактора с ЧУЖОЙ учётной записи владельцем.
 *
 * Два ограничения, и оба неслучайны:
 *   - только role='owner'. Снятие 2FA понижает защиту аккаунта до одного
 *     пароля, и это не то, что должен уметь редактор или обычный админ;
 *   - только другому пользователю. Снять фактор себе не нужно ни для чего
 *     (перепривязка идёт через setup/confirm и снятия не требует), зато это
 *     готовый способ тихо остаться с одним паролем — и, при totp_required=1,
 *     запереть самого себя. Человеку с потерянным телефоном помогает второй
 *     владелец, а не собственная кнопка.
 */
const handleRemove = async (db, req, res, params) => {
  // contentTypes=null: у DELETE нет тела, и требовать от него
  // Content-Type: application/json значило бы требовать заголовок ни к чему.
  // Барьеры Origin и X-CSRF-Token при этом остаются на месте.
  const ctx = await authorize(db, req, res, null)
  if (!ctx) return

  const now = Date.now()
  if (!requireFreshReauth(ctx, res, now)) return

  const targetId = parseUserId(params?.userId)

  const deny = (error) => {
    // Отказ пишем в журнал: попытка сделать то, на что нет прав, интереснее
    // самого действия — особенно попытка снять второй фактор.
    audit(db, {
      at: now,
      actorId: ctx.user.id,
      actor: ctx.user.username,
      action: '2fa.remove',
      entityId: targetId ?? params?.userId,
      ipHash: ctx.ipHash,
      diff: { reason: error },
      result: 'denied',
    })
    json(res, 403, { ok: false, error })
  }

  if (ctx.user.role !== 'owner') {
    deny('forbidden')
    return
  }
  if (targetId != null && targetId === ctx.user.id) {
    deny('self_removal_forbidden')
    return
  }
  if (targetId == null) {
    json(res, 404, { ok: false, error: 'user_not_found' })
    return
  }

  const target = db.get(SQL_USER, [targetId])
  if (!target) {
    json(res, 404, { ok: false, error: 'user_not_found' })
    return
  }

  const outcome = db.transaction(() => {
    const removed = db.run(SQL_DELETE_SECRET, [targetId]).changes > 0
    // Незавершённые привязки уходят вместе с фактором: иначе владелец снял
    // 2FA, а кандидат из открытой вкладки жертвы всё ещё ждал бы confirm
    // и вернул бы второй фактор на телефон, ради которого его и снимали.
    db.run(SQL_DELETE_PENDING_USER, [targetId])
    const burned = db.run(SQL_BURN_UNUSED, [now, targetId]).changes

    // Сессии гасим только если фактор действительно был. Обычная причина
    // снятия — потерянный или украденный телефон, и живая сессия на нём
    // переживёт снятие привязки, если её не отозвать. Когда снимать нечего,
    // разлогинивать человека не за что.
    const revoked = removed
      ? revokeAllForUser(db, targetId, { reason: 'admin', now })
      : 0

    audit(db, {
      at: now,
      actorId: ctx.user.id,
      actor: ctx.user.username,
      action: '2fa.remove',
      entityId: targetId,
      ipHash: ctx.ipHash,
      diff: { target: target.username, removed, burnedCodes: burned, revokedSessions: revoked },
    })

    return { removed, burned, revoked }
  })

  json(res, 200, {
    ok: true,
    removed: outcome.removed,
    burnedCodes: outcome.burned,
    revokedSessions: outcome.revoked,
  })
}

// ---------------------------------------------------------------------------
// Публичный интерфейс модуля
// ---------------------------------------------------------------------------

/**
 * Подтверждённый второй фактор пользователя либо null.
 *
 * Единственный правильный способ узнать, требуется ли TOTP на входе:
 * незавершённая привязка лежит в totp_pending, в эту выборку не попадает
 * никогда, и маршрут входа физически не может ни потребовать, ни принять код
 * от секрета, который пользователь ещё не подтвердил.
 *
 * Бросает, если секрет не расшифровывается: это либо смена APP_SECRET, либо
 * повреждённая база, и тихий null превратил бы это во «вход без второго
 * фактора» — то есть в дыру.
 *
 * @param {object} db соединение из server/db/index.js
 * @param {number} userId
 * @returns {{secret: string, digits: number, period: number, algorithm: string,
 *            lastUsedStep: number|null, confirmedAt: number} | null}
 */
export const loadConfirmedTotp = (db, userId) => {
  const row = db.get(SQL_SECRET, [userId])
  if (!row || row.confirmed_at == null) return null

  return {
    secret: open(
      { ct: row.secret_ct, iv: row.secret_iv, tag: row.secret_tag },
      PURPOSE.totpSecret
    ),
    digits: row.digits,
    period: row.period,
    algorithm: row.algorithm,
    lastUsedStep: row.last_used_step,
    confirmedAt: row.confirmed_at,
  }
}

/**
 * Запоминает принятый шаг времени. Вызывать сразу после успешной проверки
 * кода на входе: без этого один и тот же код принимается повторно, пока
 * не истечёт окно (RFC 6238 §5.2).
 *
 * Условие last_used_step < ? делает запись безопасной при гонке двух запросов:
 * назад счётчик не откатывается.
 *
 * @returns {boolean} была ли запись
 */
export const markTotpStepUsed = (db, userId, step) => {
  if (!Number.isInteger(step)) {
    throw new TypeError(`admin.2fa: шаг должен быть целым, получено ${step}`)
  }
  return db.run(SQL_MARK_STEP, [step, userId, step]).changes > 0
}

/** Сколько кодов восстановления ещё не погашено. */
export const countRecoveryCodes = (db, userId) =>
  db.get(SQL_COUNT_UNUSED, [userId])?.n ?? 0

/**
 * Погашает код восстановления. Вызывается маршрутом входа, когда пользователь
 * не может предъявить код из приложения.
 *
 * ПОГАШЕНИЕ ОДНОРАЗОВОЕ И АТОМАРНОЕ: сама пометка — это UPDATE с условием
 * used_at IS NULL и проверкой числа изменённых строк. Пара SELECT + UPDATE
 * здесь была бы гонкой: два одновременных запроса с одним и тем же кодом
 * оба увидели бы его непогашенным и оба пустили бы человека внутрь.
 *
 * Отдельное событие аудита ('2fa.recovery_used') — это не формальность.
 * Использование кода означает одно из двух: человек потерял телефон либо
 * аккаунт уводят. И то и другое требует внимания, а среди обычных входов
 * такая запись потерялась бы.
 *
 * Записью в login_attempts занимается маршрут входа: там есть введённый логин
 * и вся остальная картина попытки.
 *
 * @param {object} db
 * @param {number} userId
 * @param {string} code код в любом регистре, с разделителем или без
 * @param {{ipHash?: string|null, now?: number}} [options]
 * @returns {Promise<{ok: true, remaining: number} |
 *                   {ok: false, error: 'invalid'|'rate_limited', retryAfterSec?: number}>}
 */
export const consumeRecoveryCode = async (db, userId, code, options = {}) => {
  const { ipHash = null, now = Date.now() } = options

  const user = db.get(SQL_USER, [userId])
  // Актор в audit_log объявлен NOT NULL, и подставлять сюда 'unknown' нельзя:
  // кода без существующего пользователя не бывает, это ошибка вызывающего.
  if (!user) return { ok: false, error: 'invalid' }

  const limit = limiterFor(db).hit(`2fa-recovery:${userId}`, {
    windowMs: RECOVERY_WINDOW_MS,
    max: RECOVERY_MAX,
    now,
  })
  if (!limit.allowed) {
    return {
      ok: false,
      error: 'rate_limited',
      retryAfterSec: Math.max(1, Math.ceil((limit.resetAt - now) / 1000)),
    }
  }

  const writeAudit = (result, diff) =>
    audit(db, {
      at: now,
      actorId: user.id,
      actor: user.username,
      action: '2fa.recovery_used',
      entityId: user.id,
      ipHash,
      diff,
      result,
    })

  const normalized = normalizeRecoveryCode(code)
  if (!normalized) {
    writeAudit('denied', { reason: 'malformed' })
    return { ok: false, error: 'invalid' }
  }

  const rows = db.all(SQL_UNUSED_CODES, [userId])

  // Хеши солёные, поэтому найти код запросом нельзя — только перебрать
  // непогашенные. Цикл намеренно идёт до конца, без выхода на совпадении:
  // ранний выход делал бы время ответа зависимым от позиции кода в наборе,
  // а заодно от того, сколько кодов ещё осталось. Побочный эффект приятный —
  // каждая неудачная попытка стоит атакующему полной секунды scrypt.
  let matched = null
  for (const row of rows) {
    const ok = await verifyPassword(normalized, row.code_hash)
    if (ok && matched === null) matched = row
  }

  if (!matched) {
    writeAudit('denied', { reason: 'invalid', unused: rows.length })
    return { ok: false, error: 'invalid' }
  }

  const { changes } = db.run(SQL_REDEEM_CODE, [now, ipHash, matched.id])
  if (!changes) {
    // Строку погасил параллельный запрос, пока мы считали scrypt. Код
    // одноразовый, значит эта попытка не состоялась.
    writeAudit('denied', { reason: 'already_used' })
    return { ok: false, error: 'invalid' }
  }

  const remaining = countRecoveryCodes(db, userId)
  writeAudit('ok', { remaining })
  return { ok: true, remaining }
}

/**
 * Регистрирует маршруты второго фактора.
 *
 * @param {{register: Function}} router роутер из server/router.js
 * @param {{db: object}} deps соединение из server/db/index.js
 */
export const registerAdmin2faRoutes = (router, { db } = {}) => {
  if (!router || typeof router.register !== 'function') {
    throw new TypeError('admin.2fa: ожидается роутер из server/router.js')
  }
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('admin.2fa: в deps.db нужно соединение из server/db/index.js')
  }

  router.register('POST', '/api/admin/2fa/setup', (req, res) => handleSetup(db, req, res))
  router.register('POST', '/api/admin/2fa/confirm', (req, res) => handleConfirm(db, req, res))
  router.register('POST', '/api/admin/2fa/recovery-codes', (req, res) => handleReissue(db, req, res))
  // Параметрический маршрут регистрируется последним: у роутера он совпадёт
  // и с '/api/admin/2fa/setup', но только для метода DELETE, а для него
  // 'setup' — это просто не проходящий проверку идентификатор.
  router.register('DELETE', '/api/admin/2fa/:userId', (req, res, params) =>
    handleRemove(db, req, res, params)
  )
}
