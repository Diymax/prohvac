// Периодическая уборка базы: истёкшие ПДн, отработавшие счётчики, старый журнал.
//
// ПОЧЕМУ ЭТО НЕ ТОЛЬКО КОМАНДА CLI. Раньше уборка жила единственной командой
// `admin-cli gc`, то есть выполнялась ровно тогда, когда кто-нибудь заходил
// по SSH и вспоминал про неё. На практике это значило «никогда», а цена
// у пропуска разная для разных таблиц:
//
//   - leads.purge_after — это СРОК ХРАНЕНИЯ персональных данных. Он объявлен
//     при приёме заявки и обязан наступать сам, без чьей-либо кнопки, иначе
//     телефоны клиентов лежат в базе бессрочно вопреки собственному же сроку;
//   - rate_limit, login_attempts, audit_log растут монотонно на диске, которого
//     на тарифе 500 МБ и так остаётся единицы мегабайт.
//
// Поэтому логика живёт здесь, а зовут её двое: сервер по таймеру
// (server/index.js) и та же команда CLI, когда уборку нужно сделать прямо сейчас.
//
// CR-043. ПОЧЕМУ АРЕНДА, А НЕ ОТМЕТКА «КОГДА В ПОСЛЕДНИЙ РАЗ». Passenger держит
// пул процессов, и таймер заведётся в каждом; одновременный DELETE по всем
// таблицам из четырёх процессов — четыре конкурирующие транзакции ради одной
// и той же работы. Разводил их единственный ключ app_state.last_purge_at,
// который переставлялся ПРИ ЗАХВАТЕ. Одно значение отвечало сразу на три
// разных вопроса — «кто сейчас работает», «когда проход последний раз удался»
// и «когда можно начинать следующий», — и худший исход был именно тот, ради
// которого отметку и ставили заранее: процесс, умерший строкой позже захвата,
// уже объявил проход состоявшимся, и весь пул молчал следующие сутки, а срок
// хранения ПДн в это время просто не наступал.
//
// Теперь состояние разложено по колонкам (миграция 011_maintenance_state.sql):
// аренда (владелец, токен, срок) отвечает «кто работает», next_run_at — «когда
// можно снова», исходы — «что было». Захват двигает next_run_at всего на срок
// аренды, поэтому падение сразу после него стоит одной аренды, а не суток;
// нормальный интервал ставит только успешное завершение.

import { performance } from 'node:perf_hooks'

import { gcSessions } from '../auth/session.js'
import { createRateLimiter } from './ratelimit.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/**
 * Сроки хранения. Вынесены в экспортируемую константу и подписаны: это решения
 * про персональные данные и про диск, а не магические числа в тексте SQL.
 */
export const RETENTION = Object.freeze({
  // CR-043. Срок хранения заявки — то же самое обещание, что напечатано
  // в политике обработки данных на сайте. Физически строку стирает
  // leads.purge_after, проставленный при приёме (server/repositories/leads.js),
  // но объявлено значение здесь: политика хранения должна читаться одним
  // списком, а не собираться из репозитория, уборщика и текста на странице.
  // Расхождение с репозиторием ловит тест — оно означает, что сайт обещает
  // клиенту один срок, а база выполняет другой.
  leadsMs: 365 * DAY_MS,
  // Журнал попыток входа нужен для разбора «кто ломился ночью» и для отчёта
  // об инциденте. Три месяца — типичный горизонт такого разбора.
  loginAttemptsMs: 90 * DAY_MS,
  // Истёкшую блокировку удаляем не сразу: strikes растёт по числу блокировок
  // подряд, и слишком ранняя уборка обнуляла бы эскалацию для того, кто
  // возвращается каждую неделю.
  ipBlocksMs: 30 * DAY_MS,
  // Завершённые задачи перевода — история, интересная ровно до следующей
  // правки текста.
  translationJobsMs: 30 * DAY_MS,
  // Аудит живёт дольше всех: это единственный ответ на вопрос «кто это удалил».
  auditLogMs: 365 * DAY_MS,
  // Идентификаторы обработанных обновлений Telegram. Нужны ровно на срок,
  // в течение которого Telegram может прислать то же обновление повторно, —
  // это часы. Тридцать суток берутся с запасом на любой сбой доставки;
  // персональных данных в строке нет, только число и время.
  telegramUpdatesMs: 30 * DAY_MS,
})

// Как часто уборка имеет смысл. Сутки: все сроки выше измеряются днями,
// и более частый проход удалял бы по нулю строк, платя за это транзакцией
// и контрольной точкой WAL.
export const MAINTENANCE_INTERVAL_MS = DAY_MS

// Срок аренды. Он же — горизонт повтора после падения посреди прохода: пока
// аренда жива, работу не заберёт никто, а как только истекла — заберёт первый
// же таймер. Должен быть заметно больше бюджета времени ниже, иначе живой
// проход у самого себя отберут на последней пачке.
export const MAINTENANCE_LEASE_MS = 10 * MINUTE_MS

// Потолок времени на один проход. Уборка не обязана доделать всё за раз:
// оставшееся возьмёт следующий проход, а вот полчаса DELETE в процессе,
// который параллельно обслуживает сайт, заметны клиенту.
export const MAINTENANCE_TIME_BUDGET_MS = 5 * MINUTE_MS

// Backoff после неудачи: короткий, растущий и ограниченный сверху. Короткий —
// потому что сутки простоя означают непрошедший срок хранения ПДн; растущий и
// ограниченный — потому что заклинившая по постоянной причине уборка (нет
// места, база только для чтения) не должна долбить базу каждые пять минут.
export const MAINTENANCE_RETRY_MS = 5 * MINUTE_MS
export const MAINTENANCE_RETRY_MAX_MS = 60 * MINUTE_MS

// Размер пачки удаления. Пачка — это одна транзакция и одна блокировка записи:
// 500 строк удаляются за миллисекунды, а единый DELETE по годовому хвосту
// аудита держал бы базу заблокированной всё время своего выполнения.
export const MAINTENANCE_BATCH_SIZE = 500

/** Имена задач. Каждая арендуется и планируется отдельно. */
export const MAINTENANCE_TASK = Object.freeze({
  PURGE: 'purge',
  COMPACT: 'compact',
})

// ---------------------------------------------------------------------------
// Состояние прохода
// ---------------------------------------------------------------------------

// Захват одним выражением. Вариант «прочитать состояние, сравнить, записать»
// между двумя процессами пула пропускает обоих: оба читают старое значение
// и оба считают себя единственными. Здесь сравнение и запись — одна операция
// SQLite, поэтому changes = 1 получает ровно один процесс.
//
// next_run_at при захвате ставится на конец аренды, а не на сутки вперёд:
// это и есть исправление CR-043. Умерший сразу после захвата процесс отдаёт
// работу следующему через MAINTENANCE_LEASE_MS, а не через сутки.
const SQL_CLAIM = `
  INSERT INTO maintenance_state (
    task, lease_owner, lease_token, lease_until, started_at, next_run_at, updated_at
  ) VALUES (:task, :owner, :token, :leaseUntil, :now, :leaseUntil, :now)
  ON CONFLICT (task) DO UPDATE SET
    lease_owner = :owner,
    lease_token = :token,
    lease_until = :leaseUntil,
    started_at  = :now,
    next_run_at = :leaseUntil,
    updated_at  = :now
  WHERE maintenance_state.next_run_at <= :now
    AND maintenance_state.lease_until <= :now
`

// Завершение всегда условно по токену: процесс, застрявший дольше аренды,
// просыпается уже не владельцем, и его запоздалый результат не имеет права
// затереть проход, который тем временем сделал кто-то другой.
const SQL_FINISH_OK = `
  UPDATE maintenance_state
     SET lease_owner      = NULL,
         lease_token      = NULL,
         lease_until      = 0,
         last_success_at  = :now,
         failure_category = NULL,
         failure_streak   = 0,
         last_duration_ms = :durationMs,
         last_truncated   = :truncated,
         next_run_at      = :nextRunAt,
         updated_at       = :now
   WHERE task = :task AND lease_token = :token
`

const SQL_FINISH_FAIL = `
  UPDATE maintenance_state
     SET lease_owner      = NULL,
         lease_token      = NULL,
         lease_until      = 0,
         last_failure_at  = :now,
         failure_category = :category,
         failure_streak   = :streak,
         last_duration_ms = :durationMs,
         last_truncated   = 0,
         next_run_at      = :nextRunAt,
         updated_at       = :now
   WHERE task = :task AND lease_token = :token
`

const SQL_STATE = `
  SELECT task, lease_owner, lease_token, lease_until, started_at, next_run_at,
         last_success_at, last_failure_at, failure_category, failure_streak,
         last_duration_ms, last_truncated
    FROM maintenance_state
   WHERE task = ?
`

/**
 * Аренда, захваченная ЭТИМ процессом. Живёт в модуле, а не возвращается наружу,
 * ради обратной совместимости вызова: server/index.js делает
 * `if (!claimMaintenance(db)) return; runMaintenance(db)`, и результат прохода
 * должен записаться сам, без передачи токена через вызывающий код. Ключ — само
 * соединение: в тестах их несколько, и аренда, взятая на одной базе, не должна
 * закрываться результатом работы по другой.
 */
let heldLease = null

const positiveInt = (name, value) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`maintenance: ${name} должен быть целым > 0, получено ${value}`)
  }
  return value
}

/**
 * Классификация отказа. Категория нужна дежурному: «нет места» и «база занята»
 * требуют разных действий, а строка исключения в дашборд не годится — она может
 * содержать путь к файлу базы и текст запроса.
 *
 * @param {unknown} error
 * @returns {string} короткий код категории
 */
export const classifyMaintenanceFailure = (error) => {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(text)) return 'busy'
  if (/SQLITE_FULL|SQLITE_IOERR|ENOSPC|disk is full|disk I\/O/i.test(text)) return 'storage'
  if (/SQLITE_READONLY|attempt to write a readonly/i.test(text)) return 'readonly'
  if (/SQLITE_CORRUPT|malformed/i.test(text)) return 'corruption'
  if (/no such table|no such column|SQLITE_ERROR/i.test(text)) return 'schema'
  return 'unknown'
}

/**
 * Пауза перед следующей попыткой после неудачи. Растёт вдвое за каждую подряд
 * идущую неудачу и упирается в потолок; показатель степени ограничен отдельно,
 * чтобы длинная серия не переполнила число ещё до Math.min.
 *
 * @param {number} streak число неудач подряд, включая текущую
 * @returns {number}
 */
export const maintenanceBackoffMs = (streak) => {
  const steps = Math.min(Math.max(streak, 1) - 1, 10)
  return Math.min(MAINTENANCE_RETRY_MAX_MS, MAINTENANCE_RETRY_MS * 2 ** steps)
}

const readState = (db, task) => db.get(SQL_STATE, [task]) ?? null

/**
 * Состояние задач уборки для дашборда и CLI.
 *
 * Возвращает по строке на задачу с уже нормализованными числами: значения
 * из STRICT-таблицы приходят целыми, но отсутствующая строка (уборки ещё
 * не было) должна выглядеть как «ничего не известно», а не как отсутствие поля.
 *
 * @param {object} db
 * @returns {{purge: object, compact: object}}
 */
export const readMaintenanceStatus = (db) => {
  const view = (task) => {
    const row = readState(db, task)
    return {
      task,
      leaseOwner: row?.lease_owner ?? null,
      leaseUntil: Number(row?.lease_until) || 0,
      startedAt: Number(row?.started_at) || null,
      nextRunAt: Number(row?.next_run_at) || 0,
      lastSuccessAt: Number(row?.last_success_at) || null,
      lastFailureAt: Number(row?.last_failure_at) || null,
      failureCategory: row?.failure_category ?? null,
      failureStreak: Number(row?.failure_streak) || 0,
      lastDurationMs: row?.last_duration_ms == null ? null : Number(row.last_duration_ms),
      lastTruncated: Number(row?.last_truncated) === 1,
    }
  }

  return { purge: view(MAINTENANCE_TASK.PURGE), compact: view(MAINTENANCE_TASK.COMPACT) }
}

/**
 * Когда уборка последний раз ЗАВЕРШИЛАСЬ УСПЕХОМ.
 *
 * До CR-043 отвечало «когда её последний раз начали», и разница ровно в том
 * сбое, ради которого написана задача: захват без завершения — это не проход.
 *
 * @param {object} db соединение из server/db/index.js
 * @returns {number|null} метка времени или null, если успешных проходов не было
 */
export const lastMaintenanceAt = (db) => {
  const value = Number(readState(db, MAINTENANCE_TASK.PURGE)?.last_success_at)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Захватывает аренду на задачу.
 *
 * @returns {{task: string, owner: string, token: string, until: number, startedAt: number}|null}
 */
const acquireLease = (db, { task, now, leaseMs, owner, token }) => {
  const leaseUntil = now + leaseMs
  const claimed = db.run(SQL_CLAIM, {
    task,
    owner,
    token,
    now,
    leaseUntil,
  }).changes > 0

  return claimed ? { db, task, owner, token, until: leaseUntil, startedAt: now } : null
}

/**
 * Записывает исход прохода и снимает аренду.
 *
 * @param {object} db
 * @param {object} lease аренда, полученная acquireLease
 * @param {{ok: boolean, now: number, durationMs: number, truncated?: boolean,
 *          error?: unknown, intervalMs: number, retryMs?: number}} outcome
 * @returns {boolean} записан ли исход (false — аренду уже перехватили)
 */
const releaseLease = (db, lease, outcome) => {
  const { ok, now, durationMs, intervalMs, truncated = false } = outcome
  const rounded = Math.max(0, Math.round(durationMs))

  if (ok) {
    // Проход, упершийся в бюджет времени, — это успех с недоделанным хвостом.
    // Ставить ему полный интервал нельзя: оставшиеся строки ждали бы сутки,
    // хотя работа уже определена и стоит одной короткой паузы.
    const nextRunAt = now + (truncated ? MAINTENANCE_RETRY_MS : intervalMs)
    return db.run(SQL_FINISH_OK, {
      task: lease.task,
      token: lease.token,
      now,
      durationMs: rounded,
      truncated: truncated ? 1 : 0,
      nextRunAt,
    }).changes > 0
  }

  return db.transaction(() => {
    const streak = (Number(readState(db, lease.task)?.failure_streak) || 0) + 1
    return db.run(SQL_FINISH_FAIL, {
      task: lease.task,
      token: lease.token,
      now,
      category: classifyMaintenanceFailure(outcome.error),
      streak,
      durationMs: rounded,
      nextRunAt: now + maintenanceBackoffMs(streak),
    }).changes > 0
  })
}

/**
 * Пытается занять право на проход уборки.
 *
 * Возвращает true не более чем одному процессу и только тогда, когда прошлый
 * проход отработал своё расписание: успех отодвигает следующий на intervalMs,
 * неудача — на короткий backoff, а брошенный захват — всего на срок аренды.
 *
 * Аренда запоминается в модуле, поэтому следующий вызов runMaintenance() на том
 * же соединении сам запишет исход. Вызов runMaintenance() без захвата (команда
 * CLI) расписание не трогает.
 *
 * @param {object} db
 * @param {{now?: number, intervalMs?: number, leaseMs?: number,
 *          owner?: string, token?: string}} [options]
 * @returns {boolean}
 */
export const claimMaintenance = (db, options = {}) => {
  const {
    now = Date.now(),
    intervalMs = MAINTENANCE_INTERVAL_MS,
    leaseMs = MAINTENANCE_LEASE_MS,
    owner = `${process.pid}`,
    token = crypto.randomUUID(),
  } = options

  positiveInt('now', now)
  positiveInt('intervalMs', intervalMs)
  positiveInt('leaseMs', leaseMs)

  const lease = acquireLease(db, {
    task: MAINTENANCE_TASK.PURGE,
    now,
    leaseMs,
    owner,
    token,
  })
  if (!lease) return false

  heldLease = { ...lease, intervalMs }
  return true
}

/** Аренда, которую должен закрыть результат работы по этому соединению. */
const takeHeldLease = (db, task) => {
  if (!heldLease || heldLease.db !== db || heldLease.task !== task) return null
  const lease = heldLease
  heldLease = null
  return lease
}

/**
 * Снимает аренду, не записывая исход. Нужна тесту на падение процесса: захват
 * состоялся, работа — нет, и модуль обязан вести себя так, будто процесса
 * больше нет.
 */
export const abandonMaintenanceLease = () => {
  heldLease = null
}

// ---------------------------------------------------------------------------
// Пакетное удаление
// ---------------------------------------------------------------------------

// Пачка отбирается подзапросом по ключу, а не `DELETE ... LIMIT`: последнее
// доступно только в сборках SQLite с SQLITE_ENABLE_UPDATE_DELETE_LIMIT, а какой
// сборкой собран node:sqlite на хостинге — не наше решение.
//
// Имена таблиц и колонок подставляются из этого списка, а не из аргументов:
// в SQL уходит только литерал, объявленный в файле, а срок и размер пачки —
// параметрами.
const PURGE_STEPS = Object.freeze([
  {
    name: 'leads',
    // Единственное место с персональными данными, и purge_after проставляется
    // при приёме заявки. Это не оптимизация диска, а обязанность.
    sql: `DELETE FROM leads
           WHERE rowid IN (SELECT rowid FROM leads WHERE purge_after <= ? LIMIT ?)`,
    cutoff: ({ now }) => now,
  },
  {
    name: 'loginAttempts',
    sql: `DELETE FROM login_attempts
           WHERE rowid IN (SELECT rowid FROM login_attempts WHERE at < ? LIMIT ?)`,
    cutoff: ({ now, retention }) => now - retention.loginAttemptsMs,
  },
  {
    name: 'ipBlocks',
    // ip_blocks объявлена WITHOUT ROWID — пачка отбирается по первичному ключу.
    sql: `DELETE FROM ip_blocks
           WHERE ip_hash IN (SELECT ip_hash FROM ip_blocks WHERE blocked_until < ? LIMIT ?)`,
    cutoff: ({ now, retention }) => now - retention.ipBlocksMs,
  },
  {
    name: 'translationJobs',
    // Незавершённая задача не история, сколько бы она ни лежала: её ещё
    // предстоит выполнить, и уборка не имеет права её потерять.
    sql: `DELETE FROM translation_jobs
           WHERE rowid IN (
             SELECT rowid FROM translation_jobs
              WHERE status IN ('done', 'failed', 'skipped') AND updated_at < ?
              LIMIT ?)`,
    cutoff: ({ now, retention }) => now - retention.translationJobsMs,
  },
  {
    name: 'auditLog',
    sql: `DELETE FROM audit_log
           WHERE rowid IN (SELECT rowid FROM audit_log WHERE at < ? LIMIT ?)`,
    cutoff: ({ now, retention }) => now - retention.auditLogMs,
  },
  {
    name: 'telegramUpdates',
    // Журнал принятых нажатий в чате. Растёт по строке на нажатие и никогда
    // не перечитывается дальше окна повторов Telegram — без этого шага таблица
    // росла бы всё время жизни установки, а индекс по received_at, заведённый
    // миграцией 014 ровно под эту уборку, не делал бы ничего.
    sql: `DELETE FROM telegram_updates
           WHERE update_id IN (
             SELECT update_id FROM telegram_updates WHERE received_at < ? LIMIT ?)`,
    cutoff: ({ now, retention }) => now - retention.telegramUpdatesMs,
  },
])

/**
 * Общее тело прохода для синхронного и асинхронного вариантов.
 *
 * Генератор, а не функция с колбэком: точки уступки времени — это ровно места
 * между пачками, и оформленные как yield они не дают синхронному и
 * асинхронному вариантам разойтись в том, ЧТО именно удаляется. Каждая пачка —
 * своя транзакция: держать одну на весь проход означало бы держать блокировку
 * записи через все точки уступки, то есть остановить сайт целиком.
 *
 * Вызывающий возвращает в yield признак «время вышло».
 */
function* purgeBatches(db, { now, retention, batchSize }) {
  // Счётчики выводятся из самих шагов: перечисленные руками, они молча
  // расходились с PURGE_STEPS — новый шаг работал, но его результат приходил
  // как NaN, потому что ключа в объекте не было.
  const deleted = Object.fromEntries(PURGE_STEPS.map((step) => [step.name, 0]))

  for (const step of PURGE_STEPS) {
    const cutoff = step.cutoff({ now, retention })

    for (;;) {
      const { changes } = db.transaction(() => db.run(step.sql, [cutoff, batchSize]))
      deleted[step.name] += changes

      const outOfTime = yield { step: step.name, changes }
      // Неполная пачка означает, что подходящих строк больше нет: следующий
      // запрос удалил бы ноль строк, заплатив за это транзакцией.
      if (changes < batchSize) break
      if (outOfTime) return { deleted, truncated: true }
    }
  }

  return { deleted, truncated: false }
}

const prepareRun = (db, options) => {
  if (!db?.transaction) throw new TypeError('maintenance: нужно соединение с базой')

  const now = positiveInt('now', options.now ?? Date.now())
  const batchSize = positiveInt('batchSize', options.batchSize ?? MAINTENANCE_BATCH_SIZE)
  const timeBudgetMs = positiveInt(
    'timeBudgetMs',
    options.timeBudgetMs ?? MAINTENANCE_TIME_BUDGET_MS
  )
  const intervalMs = positiveInt('intervalMs', options.intervalMs ?? MAINTENANCE_INTERVAL_MS)
  // Длительность и бюджет считаются по монотонным часам: системное время
  // может шагнуть назад (ntp, ручная правка), и тогда проход либо «занял»
  // отрицательное время, либо не кончился бы никогда.
  const monotonic = options.monotonic ?? (() => performance.now())

  return {
    now,
    retention: { ...RETENTION, ...(options.retention ?? {}) },
    batchSize,
    timeBudgetMs,
    intervalMs,
    monotonic,
  }
}

const finishRun = (db, ctx, outcome) => {
  const lease = takeHeldLease(db, MAINTENANCE_TASK.PURGE)
  if (!lease) return

  const record = () =>
    releaseLease(db, lease, { ...outcome, now: ctx.now, intervalMs: lease.intervalMs })

  if (outcome.ok) {
    record()
    return
  }

  // Проход уже упал, и запись о падении может упасть по той же причине
  // (нет места, база только для чтения). Подменять исходную ошибку ошибкой
  // журналирования нельзя: диагноз именно в первой. Аренда истечёт сама,
  // и следующий проход возьмётся за работу заново.
  try {
    record()
  } catch (recordError) {
    console.error('[maintenance] исход прохода не записан:', recordError.message)
  }
}

/**
 * Удаляет всё, чей срок хранения истёк.
 *
 * Синхронный вариант: пачками (то есть короткими транзакциями), но без уступки
 * времени между ними — уступать в синхронной функции нечему. Так его зовёт
 * команда CLI, где процесс всё равно ничего больше не обслуживает. Серверу
 * нужен runMaintenanceAsync().
 *
 * Расписание двигает только при захваченной аренде (claimMaintenance): вызов
 * напрямую означает «прибери сейчас» и сдвигать расписание не должен.
 *
 * @param {object} db соединение из server/db/index.js
 * @param {{now?: number, retention?: Partial<typeof RETENTION>, batchSize?: number,
 *          timeBudgetMs?: number, intervalMs?: number, monotonic?: () => number}} [options]
 * @returns {{sessions: {expired: number, deleted: number}, leads: number,
 *            loginAttempts: number, ipBlocks: number, translationJobs: number,
 *            auditLog: number, rateLimit: number, truncated: boolean, durationMs: number}}
 */
export const runMaintenance = (db, options = {}) => {
  const ctx = prepareRun(db, options)
  const startedAt = ctx.monotonic()
  const outOfTime = () => ctx.monotonic() - startedAt >= ctx.timeBudgetMs

  try {
    // Сессии убирает их собственный модуль: у уборки два шага (пометить
    // просроченные, удалить отлежавшие), и знание об этом живёт там же, где
    // сами сроки.
    const sessions = gcSessions(db, ctx.now)

    const batches = purgeBatches(db, ctx)
    let state = batches.next()
    while (!state.done) state = batches.next(outOfTime())
    const { deleted, truncated } = state.value

    // Счётчики лимитера вне пакетного цикла: у них своя таблица и свой критерий
    // (два прошедших окна), и заводит её сам лимитер.
    const rateLimit = createRateLimiter(db).gc(ctx.now)

    const durationMs = ctx.monotonic() - startedAt
    finishRun(db, ctx, { ok: true, truncated, durationMs })
    return { sessions, ...deleted, rateLimit, truncated, durationMs }
  } catch (error) {
    finishRun(db, ctx, { ok: false, error, durationMs: ctx.monotonic() - startedAt })
    throw error
  }
}

/** Отдать управление циклу событий до следующей пачки. */
const yieldToEventLoop = () => new Promise((resolve) => { setImmediate(resolve) })

/**
 * То же самое, но с уступкой цикла событий между пачками.
 *
 * Это вариант для сервера: процесс, который в это же время обслуживает
 * запросы, не имеет права уйти в один непрерывный DELETE по годовому хвосту
 * аудита — каждый такой запрос выполняется целиком внутри одного тика, и всё
 * остальное ждёт его окончания.
 *
 * @param {object} db
 * @param {Parameters<typeof runMaintenance>[1]} [options]
 * @returns {Promise<ReturnType<typeof runMaintenance>>}
 */
export const runMaintenanceAsync = async (db, options = {}) => {
  const ctx = prepareRun(db, options)
  const startedAt = ctx.monotonic()
  const outOfTime = () => ctx.monotonic() - startedAt >= ctx.timeBudgetMs

  try {
    const sessions = gcSessions(db, ctx.now)

    const batches = purgeBatches(db, ctx)
    let state = batches.next()
    while (!state.done) {
      await yieldToEventLoop()
      state = batches.next(outOfTime())
    }
    const { deleted, truncated } = state.value

    const rateLimit = createRateLimiter(db).gc(ctx.now)

    const durationMs = ctx.monotonic() - startedAt
    finishRun(db, ctx, { ok: true, truncated, durationMs })
    return { sessions, ...deleted, rateLimit, truncated, durationMs }
  } catch (error) {
    finishRun(db, ctx, { ok: false, error, durationMs: ctx.monotonic() - startedAt })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Свёртка журнала
// ---------------------------------------------------------------------------

/**
 * Свернуть WAL и обновить статистику планировщика после массовых удалений.
 *
 * VACUUM не зовём намеренно: он требует места под вторую копию базы, которого
 * на 500 МБ может не быть.
 *
 * Примитив без аренды и без расписания: так его зовёт команда CLI, где «сверни
 * сейчас» — это явная просьба человека. Серверу нужен runCompaction().
 *
 * @returns {boolean} удалось ли свернуть журнал
 */
export const compactDatabase = (db) => {
  db.exec('PRAGMA optimize')
  return !db.get('PRAGMA wal_checkpoint(TRUNCATE)')?.busy
}

/**
 * Свёртка под собственной арендой и с измерением длительности.
 *
 * Отдельная задача, а не хвост уборки: PRAGMA optimize пересчитывает
 * статистику, а wal_checkpoint(TRUNCATE) переписывает файл журнала — обе
 * операции тяжёлые, обе имеют смысл ровно в одном процессе за раз, и обе
 * не должны своим отказом (журнал занят читателем) отменять удаление
 * просроченных ПДн. Длительность записывается отдельно от длительности
 * удаления: «уборка стала медленной» и «контрольная точка стала медленной» —
 * разные диагнозы.
 *
 * @param {object} db
 * @param {{now?: number, intervalMs?: number, leaseMs?: number,
 *          owner?: string, token?: string, monotonic?: () => number}} [options]
 * @returns {{ran: boolean, checkpointed?: boolean, optimizeMs?: number,
 *            checkpointMs?: number, durationMs?: number}}
 */
export const runCompaction = (db, options = {}) => {
  const now = positiveInt('now', options.now ?? Date.now())
  const intervalMs = positiveInt('intervalMs', options.intervalMs ?? MAINTENANCE_INTERVAL_MS)
  const leaseMs = positiveInt('leaseMs', options.leaseMs ?? MAINTENANCE_LEASE_MS)
  const monotonic = options.monotonic ?? (() => performance.now())

  const lease = acquireLease(db, {
    task: MAINTENANCE_TASK.COMPACT,
    now,
    leaseMs,
    owner: options.owner ?? `${process.pid}`,
    token: options.token ?? crypto.randomUUID(),
  })
  // Свёртку уже делает другой процесс пула либо она отработала своё расписание.
  if (!lease) return { ran: false }

  const startedAt = monotonic()
  try {
    db.exec('PRAGMA optimize')
    const optimizeMs = monotonic() - startedAt

    const checkpointStartedAt = monotonic()
    const checkpointed = !db.get('PRAGMA wal_checkpoint(TRUNCATE)')?.busy
    const checkpointMs = monotonic() - checkpointStartedAt

    const durationMs = monotonic() - startedAt
    releaseLease(db, lease, { ok: true, now, durationMs, intervalMs })
    return { ran: true, checkpointed, optimizeMs, checkpointMs, durationMs }
  } catch (error) {
    releaseLease(db, lease, { ok: false, now, durationMs: monotonic() - startedAt, intervalMs, error })
    throw error
  }
}
