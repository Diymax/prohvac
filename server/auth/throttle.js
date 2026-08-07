// Антибрут входа в админку: журнал попыток, прогрессивная задержка,
// эскалация до блокировки адреса и ловушки для сканеров.
//
// ПОЧЕМУ ВСЁ СОСТОЯНИЕ В SQLITE. Passenger держит ПУЛ процессов Node и кидает
// запросы между ними как попало. Счётчик неудач в памяти означал бы, что
// «10 попыток» на пуле из четырёх воркеров превращаются в 40, а после
// усыпления простаивающего воркера — обнуляются сами собой. Перебор пароля
// именно так и выглядит: много запросов подряд, которые обязаны считаться
// вместе. Поэтому источник правды — таблицы login_attempts и ip_blocks,
// а модуль не держит ни одного счётчика в замыкании.
//
// ПОЧЕМУ ДВА РАЗНЫХ СЧЁТА. Для задержки считаются неудачи ПОСЛЕ последнего
// успешного входа с этого адреса: живой человек, ошибившийся паролем и потом
// вошедший, не должен весь следующий час ждать по пять секунд. Для эскалации
// (блокировки) успех ничего не сбрасывает — иначе владелец одной настоящей
// учётки получал бы бесплатный сброс счётчика перебора чужих.
//
// Соединение приходит снаружи (server/db/index.js или DatabaseSync в тестах),
// таблицы модуль не создаёт: схема живёт в server/db/migrations/001_init.sql,
// и второе определение той же таблицы рано или поздно разъедется с первым.

import { progressiveDelayMs } from '../lib/ratelimit.js'

// ---------------------------------------------------------------------------
// Пороги
// ---------------------------------------------------------------------------

export const SOFT_WINDOW_MS = 15 * 60_000
// Столько неудач за 15 минут — уже не опечатка, а перебор. Отвечаем 429,
// но адрес ещё не блокируем: за NAT провайдера сидит целый жилой дом.
export const SOFT_MAX_FAILS = 10

export const HARD_WINDOW_MS = 60 * 60_000
// Продолжает ломиться после 429 — блокируем адрес целиком.
export const HARD_MAX_FAILS = 20

// Разных логинов с одного адреса за час. Пять — это уже не «забыл, под каким
// именем регистрировался»: админов в системе единицы, и человек знает свой
// логин. Перебор списка учёток (credential stuffing) блокируем сразу, не
// дожидаясь двадцати неудач: по паре попыток на логин их можно и не набрать.
export const STUFFING_WINDOW_MS = 60 * 60_000
export const STUFFING_MAX_USERS = 5

export const BLOCK_HOURS = 24

// Потолок срока блокировки. Без него strikes у настырного сканера за месяц
// уводят блокировку в годы, а адрес к тому времени давно передан другому
// абоненту — динамические IP переезжают.
export const MAX_BLOCK_MS = 30 * 24 * 60 * 60 * 1000
// Сколько раз удваивать срок. 2^6 = 64 суток базовой блокировки, дальше всё
// равно срежет MAX_BLOCK_MS — считать больше незачем, а сдвиг на 60+ разрядов
// в SQLite переполнил бы знаковое 64-битное целое.
const MAX_DOUBLINGS = 6

// Сколько держим журнал попыток. Это ответ на вопрос «кто ломился ночью»,
// он нужен неделями, а не месяцами: диск на тарифе 500 МБ на всё.
export const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Истёкшая блокировка удаляется не сразу: в строке лежат strikes, и без них
// вернувшийся через сутки сканер снова получил бы «первую» блокировку на 24 ч
// вместо удвоенной. Строка живёт как память об эскалации.
export const BLOCK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Ровно те списки, что зашиты в CHECK таблицы login_attempts. Проверяем в JS,
// чтобы опечатка падала понятной ошибкой здесь, а не констрейнтом SQLite
// посреди обработки логина, превращая штатный отказ в 500.
export const ATTEMPT_STAGES = new Set(['password', 'totp', 'recovery'])
export const ATTEMPT_OUTCOMES = new Set([
  'ok', 'bad_password', 'bad_totp', 'bad_recovery',
  'unknown_user', 'disabled', 'locked', 'rate_limited',
])

// Что считается неудачей для счётчиков.
//
// 'locked', 'disabled' и 'rate_limited' сюда НЕ входят намеренно: это наши
// собственные отказы, и если их считать, то отказ порождает отказ — один
// заблокированный человек, дёргающий кнопку, сам себе продлевает блокировку
// до бесконечности. Считаем только реальные попытки угадать секрет.
export const FAILURE_OUTCOMES = Object.freeze([
  'bad_password', 'bad_totp', 'bad_recovery', 'unknown_user',
])

// Список для IN (...). Значения — константы этого файла, а не пользовательский
// ввод, поэтому подстановка в SQL безопасна; параметризовать IN-список
// в SQLite всё равно нечем.
const FAILS = FAILURE_OUTCOMES.map((outcome) => `'${outcome}'`).join(', ')

// Причины блокировки из CHECK таблицы ip_blocks.
export const BLOCK_REASONS = new Set(['login_bruteforce', 'rate_limit', 'lead_spam', 'manual'])

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SQL_INSERT_ATTEMPT = `
  INSERT INTO login_attempts (at, username, ip_hash, stage, outcome)
  VALUES (:at, :username, :ip, :stage, :outcome)
  RETURNING id, at
`

const SQL_COUNT_FAILS = `
  SELECT COUNT(*) AS n
    FROM login_attempts
   WHERE ip_hash = :ip
     AND at > :since
     AND outcome IN (${FAILS})
`

// Неудачи после последнего успеха. MAX(:since, ...) с двумя аргументами —
// скалярная функция, MAX(at) внутри подзапроса — агрегат; это разные вещи,
// несмотря на одно имя.
const SQL_COUNT_FAILS_SINCE_OK = `
  SELECT COUNT(*) AS n
    FROM login_attempts
   WHERE ip_hash = :ip
     AND outcome IN (${FAILS})
     AND at > MAX(:since, COALESCE((
           SELECT MAX(at) FROM login_attempts
            WHERE ip_hash = :ip AND outcome = 'ok' AND at > :since
         ), 0))
`

// Время N-й с конца неудачи: именно в этот момент + окно счётчик опустится
// ниже порога. Из него получается честный Retry-After, а не «подождите
// пятнадцать минут» на каждый запрос.
const SQL_NTH_FAIL_AT = `
  SELECT at
    FROM login_attempts
   WHERE ip_hash = :ip
     AND at > :since
     AND outcome IN (${FAILS})
   ORDER BY at DESC
   LIMIT 1 OFFSET :skip
`

// COUNT(DISTINCT username) сравнивает по collation колонки, а она объявлена
// COLLATE NOCASE — 'Admin' и 'admin' считаются одним логином, иначе перебор
// регистров изображал бы пять разных учёток. NULL агрегат пропускает сам.
const SQL_DISTINCT_USERS = `
  SELECT COUNT(DISTINCT username) AS n
    FROM login_attempts
   WHERE ip_hash = :ip
     AND at > :since
     AND outcome IN (${FAILS})
`

// Блокировка одним UPSERT, а не «прочитать strikes, посчитать, записать»:
// между чтением и записью соседний процесс пула успевает сделать то же самое,
// и один из двух инкрементов теряется. Здесь всё считает SQLite внутри одного
// выражения, то есть атомарно.
//
// MAX(blocked_until, ...) не даёт укоротить уже выданную блокировку: без него
// повторное срабатывание с меньшим сроком (например, ловушка после ручного
// бана на неделю) сократило бы наказание.
//
// Потолок capMs ограничивает только УДВОЕНИЕ (внешний MAX с :baseMs): если
// администратор осознанно банит адрес на полгода, автоматика не имеет права
// сократить это до тридцати суток.
const SQL_BLOCK = `
  INSERT INTO ip_blocks (ip_hash, blocked_until, strikes, reason, updated_at)
  VALUES (:ip, :now + :baseMs, 1, :reason, :now)
  ON CONFLICT(ip_hash) DO UPDATE SET
    strikes       = ip_blocks.strikes + 1,
    reason        = excluded.reason,
    updated_at    = :now,
    blocked_until = MAX(
                      ip_blocks.blocked_until,
                      :now + MAX(
                        :baseMs,
                        MIN(:baseMs * (1 << MIN(ip_blocks.strikes, :maxDoublings)), :capMs)
                      )
                    )
  RETURNING *
`

const SQL_SELECT_BLOCK = 'SELECT * FROM ip_blocks WHERE ip_hash = ?'
const SQL_DELETE_BLOCK = 'DELETE FROM ip_blocks WHERE ip_hash = ?'
const SQL_LIST_BLOCKS = 'SELECT * FROM ip_blocks ORDER BY blocked_until DESC'

const SQL_RESET_USER = `
  UPDATE users
     SET failed_attempts = 0, locked_until = NULL, lock_level = 0, updated_at = :now
   WHERE username = :username
`

const SQL_GC_ATTEMPTS = 'DELETE FROM login_attempts WHERE at <= ?'
const SQL_GC_BLOCKS = 'DELETE FROM ip_blocks WHERE blocked_until <= ?'

// ---------------------------------------------------------------------------
// Валидация входа
// ---------------------------------------------------------------------------

// Ровно 64 знака нижнего hex — то же, что проверяет CHECK в схеме. Смысл
// проверки не в формате, а в том, чтобы поймать сырой IP: любой адрес короче
// (IPv6 максимум 45 символов), и запись его в открытом виде — утечка ПДн.
const IP_HASH_PATTERN = /^[0-9a-f]{64}$/

const assertIpHash = (value) => {
  if (typeof value !== 'string' || !IP_HASH_PATTERN.test(value)) {
    throw new TypeError(
      'throttle: ipHash должен быть HMAC-хешем адреса (64 знака hex), ' +
      'см. hashIp() из server/crypto/hashid.js'
    )
  }
  return value
}

const assertInt = (name, value) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`throttle: ${name} должен быть целым > 0, получено ${value}`)
  }
  return value
}

const assertStage = (stage) => {
  if (!ATTEMPT_STAGES.has(stage)) {
    throw new TypeError(`throttle: недопустимый stage ${JSON.stringify(stage)}`)
  }
  return stage
}

const assertOutcome = (outcome) => {
  if (!ATTEMPT_OUTCOMES.has(outcome)) {
    throw new TypeError(`throttle: недопустимый outcome ${JSON.stringify(outcome)}`)
  }
  return outcome
}

const assertReason = (reason) => {
  if (!BLOCK_REASONS.has(reason)) {
    throw new TypeError(`throttle: недопустимая причина блокировки ${JSON.stringify(reason)}`)
  }
  return reason
}

// Логин пишется как есть — это улика, а не ключ. Но обрезаем: поле формы
// принимает сколько угодно, и мегабайтная строка в журнале попыток
// раздувает базу ровно тем, от чего мы защищаемся.
const MAX_USERNAME_LEN = 64
const normalizeUsername = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, MAX_USERNAME_LEN)
  return trimmed || null
}

// Кэш подготовленных выражений на соединение. Соединение приходит снаружи,
// поэтому в замыкание statement'ы не сложить — а повторный prepare на каждом
// запросе логина это повторный разбор SQL. WeakMap не удерживает закрытую
// базу: в тестах их десятки.
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

// ---------------------------------------------------------------------------
// Ловушки для сканеров
// ---------------------------------------------------------------------------

// Пути, по которым не ходит ни один живой посетитель и ни один поисковый
// робот: их знают только массовые сканеры уязвимостей. Обращение сюда — не
// «подозрительно», а однозначная улика, поэтому наказание немедленное и
// не требует накопления счётчика.
//
// Список короткий намеренно: каждый путь должен быть заведомо чужим.
// '/admin' сюда не годится — по нему постучится и собственный сотрудник.
export const HONEYPOT_PATHS = Object.freeze(new Set([
  '/wp-login.php',
  '/wp-admin',
  '/.env',
  '/.git/config',
  '/phpmyadmin',
  '/xmlrpc.php',
  '/administrator',
  '/.aws/credentials',
  '/config.php',
  '/vendor/phpunit',
]))

/**
 * Ведёт ли путь в ловушку.
 *
 * Сравнение нечувствительно к регистру и к хвосту: сканер запрашивает
 * и '/wp-admin/', и '/wp-admin/setup-config.php', и '/vendor/phpunit/phpunit/
 * phpunit.php' — это одна и та же попытка. Query-строка и якорь отбрасываются,
 * процентное кодирование разворачивается: '/%2Eenv' обязан ловиться так же,
 * как '/.env', иначе ловушка обходится одним символом.
 */
export const isHoneypot = (path) => {
  if (typeof path !== 'string' || !path) return false

  let value = path.split('?')[0].split('#')[0]
  try {
    value = decodeURIComponent(value)
  } catch {
    // Битая последовательность вида '%zz' — decodeURIComponent бросает.
    // Сравниваем как есть: мусорный путь не перестаёт быть путём.
  }

  // Схлопываем повторные слэши ('//.env') и убираем хвостовой: и то и другое
  // ведёт к тому же ресурсу, но ломало бы точное сравнение.
  value = value.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (!value.startsWith('/')) value = `/${value}`

  if (HONEYPOT_PATHS.has(value)) return true
  for (const trap of HONEYPOT_PATHS) {
    if (value.startsWith(`${trap}/`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Фабрика
// ---------------------------------------------------------------------------

/**
 * @param {object} db соединение node:sqlite (DatabaseSync) или драйвер
 *                    из server/db/index.js — нужен только prepare()
 */
export const createThrottle = (db) => {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('throttle: ожидается соединение с базой (db.prepare)')
  }

  const countFails = (ipHash, since) =>
    prepared(db, SQL_COUNT_FAILS).get({ ip: ipHash, since }).n

  const countFailsSinceOk = (ipHash, since) =>
    prepared(db, SQL_COUNT_FAILS_SINCE_OK).get({ ip: ipHash, since }).n

  // Действующая блокировка или null. Истёкшую строку (её ещё не унёс
  // gcThrottle) считаем отсутствующей: блокировка — это только сравнение
  // blocked_until со временем.
  const activeBlock = (ipHash, now) => {
    const row = prepared(db, SQL_SELECT_BLOCK).get(ipHash)
    return row && row.blocked_until > now ? row : null
  }

  /**
   * Пишет попытку входа в журнал. Пишется всё, включая неизвестные логины
   * и наши собственные отказы: без строки 'rate_limited' в аудите непонятно,
   * почему в разгар перебора попытки вдруг прекратились.
   *
   * @returns {{id: number, at: number}}
   */
  const recordAttempt = ({
    ipHash,
    username = null,
    stage = 'password',
    outcome = 'bad_password',
    now = Date.now(),
  } = {}) => {
    assertIpHash(ipHash)
    assertStage(stage)
    assertOutcome(outcome)
    assertInt('now', now)

    return prepared(db, SQL_INSERT_ATTEMPT).get({
      at: now,
      username: normalizeUsername(username),
      ip: ipHash,
      stage,
      outcome,
    })
  }

  /**
   * Блокирует адрес. Повторный вызов наращивает strikes и удваивает срок:
   * первый раз hours, второй 2×hours, третий 4×hours — и так до MAX_BLOCK_MS.
   *
   * @returns {object} строка ip_blocks после изменения
   */
  const blockIp = (ipHash, { hours = BLOCK_HOURS, reason = 'login_bruteforce', now = Date.now() } = {}) => {
    assertIpHash(ipHash)
    assertReason(reason)
    assertInt('now', now)

    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
      throw new TypeError(`throttle: hours должен быть числом > 0, получено ${hours}`)
    }
    // Колонка INTEGER в STRICT-таблице: дробные часы (0.5 для теста, 1/3 из
    // расчёта) дали бы нецелое значение и упали бы на вставке.
    const baseMs = Math.max(1, Math.round(hours * 3_600_000))

    return prepared(db, SQL_BLOCK).get({
      ip: ipHash,
      now,
      baseMs,
      reason,
      maxDoublings: MAX_DOUBLINGS,
      capMs: MAX_BLOCK_MS,
    })
  }

  /** Снимает блокировку вместе с накопленными strikes: это осознанное
   *  решение администратора, что адрес чистый. @returns {number} 0 или 1 */
  const unblockIp = (ipHash) => {
    assertIpHash(ipHash)
    return prepared(db, SQL_DELETE_BLOCK).run(ipHash).changes
  }

  /**
   * Все известные блокировки, свежие сверху. Истёкшие тоже: по ним видно
   * историю адреса и накопленные strikes, а флаг active отделяет
   * действующие от отлежавших.
   */
  const listBlocks = ({ now = Date.now() } = {}) =>
    prepared(db, SQL_LIST_BLOCKS).all().map((row) => ({
      ...row,
      active: row.blocked_until > now,
    }))

  /**
   * Состояние адреса перед тем, как вообще проверять пароль.
   *
   * delayMs считается всегда, в том числе для незаблокированных: это плата
   * за прошлые неудачи, которую вызывающий код отдаёт через settleAt()
   * из server/lib/timing.js.
   *
   * @returns {{blocked: boolean, until: number, delayMs: number, reason: string|null}}
   */
  const checkIp = (ipHash, { now = Date.now() } = {}) => {
    assertIpHash(ipHash)
    assertInt('now', now)

    const block = activeBlock(ipHash, now)
    const fails = countFailsSinceOk(ipHash, now - HARD_WINDOW_MS)

    return {
      blocked: Boolean(block),
      until: block ? block.blocked_until : 0,
      delayMs: progressiveDelayMs(fails),
      reason: block ? block.reason : null,
    }
  }

  /**
   * Перебор списка логинов с одного адреса.
   *
   * Проверяется отдельно от счётчика неудач, потому что stuffing выглядит
   * иначе: по одной-две попытки на каждый из десятка логинов — двадцати
   * неудач за час может и не набраться, а это самый опасный вид атаки
   * (пароли из чужой утёкшей базы подходят чаще, чем угаданные).
   *
   * @returns {{detected: boolean, usernames: number, until: number}}
   */
  const detectStuffing = (ipHash, { now = Date.now() } = {}) => {
    assertIpHash(ipHash)
    assertInt('now', now)

    const usernames = prepared(db, SQL_DISTINCT_USERS)
      .get({ ip: ipHash, since: now - STUFFING_WINDOW_MS }).n

    if (usernames < STUFFING_MAX_USERS) return { detected: false, usernames, until: 0 }

    // Уже заблокирован — не наказываем второй раз: каждый вызов blockIp
    // удваивает срок, и десяток запросов подряд от одного сканера увёл бы
    // блокировку в потолок за секунду. Наращивает strikes новый эпизод,
    // а не продолжение старого.
    const current = activeBlock(ipHash, now)
    if (current) return { detected: true, usernames, until: current.blocked_until }

    const block = blockIp(ipHash, { hours: BLOCK_HOURS, reason: 'login_bruteforce', now })
    return { detected: true, usernames, until: block.blocked_until }
  }

  /**
   * Учитывает неудачную попытку и решает, что делать дальше.
   *
   * Попытку записывает САМ (record: false — если вызывающий код уже сделал
   * это через recordAttempt); двойной вызов удвоил бы счётчик и наказание.
   *
   * Лестница: задержка → 429 на 15-минутном окне → блокировка адреса на
   * часовом окне. Мягкая ступень существует ровно затем, чтобы за общим NAT
   * (офис, домовая сеть, мобильный оператор) один перебирающий не отрезал
   * от админки остальных на сутки.
   *
   * @returns {{blocked: boolean, until: number, delayMs: number,
   *            reason: string|null, fails: number}}
   */
  const registerFailure = ({
    ipHash,
    username = null,
    stage = 'password',
    outcome = 'bad_password',
    now = Date.now(),
    record = true,
  } = {}) => {
    assertIpHash(ipHash)
    assertInt('now', now)

    if (record) recordAttempt({ ipHash, username, stage, outcome, now })

    const failsHour = countFails(ipHash, now - HARD_WINDOW_MS)
    const failsSoft = countFails(ipHash, now - SOFT_WINDOW_MS)
    const delayMs = progressiveDelayMs(countFailsSinceOk(ipHash, now - HARD_WINDOW_MS))

    // Действующая блокировка отвечает раньше любой эскалации: строку в журнал
    // мы записали (перебор продолжается — это надо видеть), но повторно
    // удваивать срок за каждый запрос уже заблокированного адреса нельзя.
    const current = activeBlock(ipHash, now)
    if (current) {
      return {
        blocked: true,
        until: current.blocked_until,
        delayMs,
        reason: 'ip_blocked',
        fails: failsHour,
      }
    }

    const stuffing = detectStuffing(ipHash, { now })
    if (stuffing.detected) {
      return {
        blocked: true,
        until: stuffing.until,
        delayMs,
        reason: 'credential_stuffing',
        fails: failsHour,
      }
    }

    if (failsHour >= HARD_MAX_FAILS) {
      const block = blockIp(ipHash, { hours: BLOCK_HOURS, reason: 'login_bruteforce', now })
      return {
        blocked: true,
        until: block.blocked_until,
        delayMs,
        reason: 'ip_blocked',
        fails: failsHour,
      }
    }

    if (failsSoft >= SOFT_MAX_FAILS) {
      // Момент, когда самая старая из десяти последних неудач выпадет из окна:
      // до него счётчик ниже порога не опустится. Fallback на полное окно —
      // на случай, если строку успел унести gcThrottle между двумя запросами.
      const nth = prepared(db, SQL_NTH_FAIL_AT).get({
        ip: ipHash,
        since: now - SOFT_WINDOW_MS,
        skip: SOFT_MAX_FAILS - 1,
      })
      return {
        blocked: true,
        until: (nth ? nth.at : now) + SOFT_WINDOW_MS,
        delayMs,
        reason: 'too_many_attempts',
        fails: failsSoft,
      }
    }

    return { blocked: false, until: 0, delayMs, reason: null, fails: failsHour }
  }

  /**
   * Успешный вход: пишет 'ok' в журнал и обнуляет счётчики УЧЁТКИ
   * (users.failed_attempts, locked_until, lock_level).
   *
   * Блокировка и strikes адреса не снимаются намеренно. Иначе владелец одной
   * настоящей учётки получал бы кнопку «сбросить антибрут»: вошёл под собой —
   * и перебирай остальных заново. Задержка по адресу при этом обнулится сама,
   * потому что считается от последнего успеха.
   *
   * @returns {{reset: number}} сколько строк users обновлено (0, если логина
   *   нет в базе — успешный вход неизвестного пользователя невозможен, но
   *   функция не обязана об этом знать)
   */
  const registerSuccess = ({ ipHash, username = null, stage = 'password', now = Date.now() } = {}) => {
    assertIpHash(ipHash)
    assertInt('now', now)

    recordAttempt({ ipHash, username, stage, outcome: 'ok', now })

    const name = normalizeUsername(username)
    if (!name) return { reset: 0 }

    // Сравнение по COLLATE NOCASE колонки users.username: 'Admin' и 'admin' —
    // одна учётка, и сбросить счётчик обязаны обоим написаниям.
    return { reset: prepared(db, SQL_RESET_USER).run({ now, username: name }).changes }
  }

  /**
   * Обращение к ловушке. Сразу strike: живому посетителю в /wp-login.php
   * делать нечего, а сканер за этим запросом продолжит перебирать пути
   * и формы, и дешевле не пускать его вовсе.
   *
   * В login_attempts такое не пишется: CHECK колонок stage/outcome описывает
   * этапы логина, и honeypot в них не втискивается без вранья.
   */
  const registerHoneypot = ({ ipHash, hours = BLOCK_HOURS, now = Date.now() } = {}) =>
    blockIp(ipHash, { hours, reason: 'rate_limit', now })

  /**
   * Уборка. Вызывать из планировщика, а не из обработчика запроса: DELETE
   * по всей таблице не место на горячем пути логина.
   *
   * @returns {{attempts: number, blocks: number}}
   */
  const gcThrottle = (
    now = Date.now(),
    { attemptRetentionMs = ATTEMPT_RETENTION_MS, blockRetentionMs = BLOCK_RETENTION_MS } = {}
  ) => {
    assertInt('now', now)

    const attempts = prepared(db, SQL_GC_ATTEMPTS).run(now - attemptRetentionMs).changes
    // Истёкшие блокировки удаляются с отсрочкой — см. BLOCK_RETENTION_MS.
    const blocks = prepared(db, SQL_GC_BLOCKS).run(now - blockRetentionMs).changes
    return { attempts, blocks }
  }

  return {
    recordAttempt,
    checkIp,
    registerFailure,
    registerSuccess,
    detectStuffing,
    blockIp,
    unblockIp,
    listBlocks,
    registerHoneypot,
    gcThrottle,
  }
}
