// Учёт израсходованных символов и предполётная проверка квоты.
//
// ЗАЧЕМ СВОЙ СЧЁТЧИК, ЕСЛИ У DEEPL ЕСТЬ /v2/usage. Затем, что спрашивать его
// перед каждой пачкой — это второй сетевой запрос на каждый перевод, а не
// спрашивать вовсе нельзя: тем же ключом могли пользоваться из другого места.
// Поэтому источников два. Ответ провайдера авторитетен и кэшируется в settings
// на несколько минут; между обновлениями к нему прибавляется наш собственный
// счётчик отправленного. У провайдеров без счётчика (MyMemory) остаётся только
// наш, и он же даёт цифру для админки.
//
// ПОЧЕМУ В SETTINGS, А НЕ В ПАМЯТИ. Passenger держит пул процессов: счётчик
// в модуле означал бы «квота умножена на число процессов», а обнаруживалось бы
// это письмом от провайдера о перерасходе.
//
// ПОРОГ 95%, А НЕ 100%. Пачка отправляется целиком, и её стоимость известна
// только приблизительно: наш счётчик отстаёт от провайдерского на время
// кэширования, а сам провайдер округляет по-своему. Запас в 5% — это место,
// в которое укладывается расхождение, чтобы упереться в лимит на предполётной
// проверке, а не получить 456 посреди пачки, за которую уже списали символы.
//
// ЗАЧЕМ РЕЗЕРВАЦИИ (CR-040). Схема «preflight → запрос к провайдеру →
// usage.add» — это три шага и два await между ними. Два процесса пула успевали
// пройти проверку по одному и тому же остатку и оба отправляли пачку, поэтому
// жёсткий месячный лимит превышался ровно во столько раз, сколько процессов
// работало. Резервация делает решение и учёт одним атомарным шагом: символы
// удерживаются ДО отправки и превращаются в фактический расход только после
// ответа провайдера. Срок жизни удержания обязателен — иначе процесс, упавший
// между вставкой и подтверждением, съедал бы квоту до конца месяца.

import { randomBytes } from 'node:crypto'

import { SETTINGS, readJsonSetting, writeJsonSetting } from './provider.js'

export const SAFETY_RATIO = 0.95

// Свежесть ответа провайдера об остатке. Пять минут: за это время воркер
// успевает отправить десяток пачек, и все они учтутся локальной прибавкой.
const QUOTA_TTL_MS = 5 * 60_000

// Сколько живёт неподтверждённое удержание. Одна пачка — это один HTTP-запрос
// с таймаутом 20 с (provider.js); минуты хватает с запасом, а держать дольше
// значит вычитать из квоты символы за процесс, которого уже нет.
const RESERVATION_TTL_MS = 60_000

// Урегулированные удержания живут сутки: они не участвуют в расчёте, но по ним
// разбирают расхождение с провайдером. Дальше это просто рост файла базы.
const RESERVATION_KEEP_MS = 24 * 60 * 60_000

// Известные месячные лимиты. Только как запасной вариант: настоящий приходит
// от провайдера, а перекрыть его можно настройкой translation.limits.
const DEFAULT_LIMITS = Object.freeze({
  // Бесплатный тариф DeepL — 500 000 символов в месяц.
  deepl: 500_000,
  // У MyMemory лимит суточный, в словах и по адресу — в символах он
  // не выражается, поэтому предполётной проверки для него нет.
  mymemory: null,
})

/**
 * Ключ месяца в UTC. Именно UTC, а не локальная зона: процессы на хостинге
 * и в тестах живут в разных TZ, и на границе месяца счётчик иначе обнулялся бы
 * дважды либо не обнулялся вовсе.
 */
export const monthKey = (now = Date.now()) => {
  const date = new Date(now)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * @param {object} db соединение из server/db/index.js
 * @param {{quotaTtlMs?: number, safetyRatio?: number}} [options]
 */
export const createUsage = (db, options = {}) => {
  const quotaTtlMs = options.quotaTtlMs ?? QUOTA_TTL_MS
  const safetyRatio = options.safetyRatio ?? SAFETY_RATIO

  const localKey = (code) => `${SETTINGS.usagePrefix}${code}`
  const quotaKey = (code) => `${SETTINGS.quotaPrefix}${code}`

  /** Наш счётчик за текущий месяц. Прошлый месяц не переносится. */
  const readLocal = (code, now = Date.now()) => {
    const month = monthKey(now)
    const stored = readJsonSetting(db, localKey(code), null)
    if (!stored || stored.month !== month) return { month, chars: 0, requests: 0 }

    return {
      month,
      chars: Number(stored.chars) || 0,
      requests: Number(stored.requests) || 0,
    }
  }

  /**
   * Прибавляет отправленные символы.
   *
   * В транзакции, потому что «прочитать JSON, изменить, записать» — не атомарная
   * операция, а процессов в пуле несколько. BEGIN IMMEDIATE драйвера
   * выстраивает их в очередь; без него два воркера, отправившие по пачке
   * одновременно, записали бы одну и ту же сумму и потеряли половину расхода.
   */
  const add = (code, chars, now = Date.now()) => {
    const delta = Math.max(0, Math.trunc(Number(chars) || 0))

    return db.transaction(() => {
      const current = readLocal(code, now)
      const next = {
        month: current.month,
        chars: current.chars + delta,
        requests: current.requests + 1,
        updatedAt: now,
      }
      writeJsonSetting(db, localKey(code), next, now)
      return next
    })
  }

  // --- удержания квоты (CR-040) --------------------------------------------

  const SQL_RECLAIM = `
    UPDATE translation_quota_reservations
       SET state = 'released', reason = 'expired', settled_at = ?
     WHERE state = 'held' AND expires_at <= ? AND (? IS NULL OR provider = ?)
  `

  const SQL_HELD = `
    SELECT COALESCE(SUM(chars), 0) AS chars
      FROM translation_quota_reservations
     WHERE provider = ? AND month = ? AND state = 'held' AND expires_at > ?
  `

  const SQL_PRUNE = `
    DELETE FROM translation_quota_reservations
     WHERE state <> 'held' AND settled_at IS NOT NULL AND settled_at < ?
  `

  /**
   * Возвращает в оборот удержания, срок которых вышел.
   *
   * @param {string|null} code провайдер либо null — все
   * @returns {number} сколько удержаний снято
   */
  const reclaimExpired = (code = null, now = Date.now()) =>
    db.run(SQL_RECLAIM, [now, now, code ?? null, code ?? null]).changes ?? 0

  /** Сумма живых удержаний по провайдеру за текущий месяц. */
  const heldChars = (code, now = Date.now()) =>
    Number(db.get(SQL_HELD, [code, monthKey(now), now])?.chars) || 0

  const prune = (now) => db.run(SQL_PRUNE, [now - RESERVATION_KEEP_MS])

  /**
   * Расход провайдера, не покрытый нашим счётчиком.
   *
   * Снимок берётся до транзакции (он может ходить в сеть), а решение о квоте
   * принимается внутри неё и по свежему счётчику. Вычитание нужно, чтобы
   * прибавка соседнего воркера, случившаяся между снимком и транзакцией,
   * учлась ровно один раз.
   */
  const providerBaseline = (state, local) => Math.max(0, state.used - local.chars)

  /**
   * Удерживает символы под пачку. Решение и вставка — одна транзакция, поэтому
   * второй воркер на границе квоты видит чужое удержание и получает отказ.
   *
   * @param {string} code
   * @param {object|null} provider
   * @param {{chars: number, owner: string, ttlMs?: number, now?: number,
   *          signal?: AbortSignal}} options2
   * @returns {Promise<{ok: true, token: string, chars: number}|
   *                   {ok: false, reason: string, used: number, limit: number|null}>}
   */
  const reserve = async (code, provider = null, options2 = {}) => {
    const {
      chars = 0,
      owner = 'unknown',
      ttlMs = RESERVATION_TTL_MS,
      now = Date.now(),
      signal = null,
    } = options2

    const want = Math.max(0, Math.trunc(Number(chars) || 0))
    const state = await snapshot(code, provider, { now, signal })
    const baseline = providerBaseline(state, readLocal(code, now))

    return db.transaction(() => {
      reclaimExpired(code, now)

      const used = baseline + readLocal(code, now).chars
      const held = heldChars(code, now)

      if (state.limit) {
        const ceiling = state.limit * safetyRatio
        if (used + held + want > ceiling) {
          return { ok: false, reason: 'quota_exhausted', used: used + held, limit: state.limit }
        }
      }

      const token = randomBytes(16).toString('hex')
      db.run(
        `INSERT INTO translation_quota_reservations
           (provider, month, chars, owner, token, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'held', ?, ?)`,
        [code, monthKey(now), want, String(owner), token, now, now + Math.max(1, ttlMs)]
      )

      return { ok: true, token, chars: want, used: used + held, limit: state.limit }
    })
  }

  /**
   * Превращает удержание в фактический расход.
   *
   * Удержание, снятое по истечении срока, тоже подтверждается: символы у
   * провайдера уже потрачены, и «резерв протух» не отменяет счёт. Не
   * подтверждается только то, что освобождено явно (отказ до отправки) —
   * такой расход не состоялся.
   *
   * @returns {boolean} было ли что подтверждать
   */
  const commit = (token, billedChars = null, now = Date.now()) =>
    db.transaction(() => {
      const row = db.get(
        'SELECT provider, chars, state, reason FROM translation_quota_reservations WHERE token = ?',
        [String(token)]
      )
      if (!row) return false
      if (row.state === 'committed') return false
      if (row.state === 'released' && row.reason !== 'expired') return false

      const billed = Math.max(0, Math.trunc(Number(billedChars ?? row.chars) || 0))
      db.run(
        `UPDATE translation_quota_reservations
            SET state = 'committed', chars = ?, reason = 'billed', settled_at = ?
          WHERE token = ? AND state <> 'committed'`,
        [billed, now, String(token)]
      )
      add(row.provider, billed, now)
      prune(now)
      return true
    })

  /**
   * Снимает удержание, за которым не последовало отправки.
   *
   * @param {string} token
   * @param {string} reason 'pre_send_failure' | 'lease_lost' | ...
   */
  const release = (token, reason = 'pre_send_failure', now = Date.now()) =>
    db.transaction(() => {
      const info = db.run(
        `UPDATE translation_quota_reservations
            SET state = 'released', reason = ?, settled_at = ?
          WHERE token = ? AND state = 'held'`,
        [String(reason).slice(0, 60), now, String(token)]
      )
      prune(now)
      return (info.changes ?? 0) > 0
    })

  /** Снимает все живые удержания владельца — используется при остановке. */
  const releaseOwned = (owner, reason = 'shutdown', now = Date.now()) =>
    db.run(
      `UPDATE translation_quota_reservations
          SET state = 'released', reason = ?, settled_at = ?
        WHERE owner = ? AND state = 'held'`,
      [String(reason).slice(0, 60), now, String(owner)]
    ).changes ?? 0

  /** Лимит из настроек либо из таблицы известных. null — лимит неизвестен. */
  const configuredLimit = (code) => {
    const limits = readJsonSetting(db, SETTINGS.monthlyLimits, null)
    const fromSettings = limits && typeof limits === 'object' ? Number(limits[code]) : NaN
    if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings

    const known = DEFAULT_LIMITS[code]
    return Number.isFinite(known) && known > 0 ? known : null
  }

  /**
   * Кэшированный ответ провайдера об остатке. Хранится в settings, потому что
   * кэш в памяти процесса означал бы столько запросов к провайдеру, сколько
   * процессов в пуле.
   */
  const readQuotaCache = (code, now) => {
    const stored = readJsonSetting(db, quotaKey(code), null)
    if (!stored || now - (Number(stored.at) || 0) > quotaTtlMs) return null

    const used = Number(stored.used)
    if (!Number.isFinite(used)) return null

    const limit = Number(stored.limit)
    return {
      used,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
      at: Number(stored.at) || 0,
      baseChars: Number(stored.baseChars) || 0,
    }
  }

  /**
   * Расход и лимит провайдера.
   *
   * source = 'provider' — цифра от самого сервиса плюс то, что мы отправили
   * уже после её получения (иначе между обновлениями кэша расход выглядел бы
   * замершим, и предполётная проверка пропускала бы пачки за квотой).
   * source = 'local' — считаем сами.
   *
   * @returns {Promise<{provider: string, used: number, limit: number|null,
   *                    month: string, source: 'provider'|'local'}>}
   */
  const snapshot = async (code, provider = null, options2 = {}) => {
    const { now = Date.now(), signal = null } = options2
    const local = readLocal(code, now)

    let cache = readQuotaCache(code, now)

    if (!cache && typeof provider?.usage === 'function') {
      try {
        const fresh = await provider.usage({ now, signal })
        if (fresh && Number.isFinite(Number(fresh.used))) {
          cache = {
            used: Number(fresh.used),
            limit: Number.isFinite(Number(fresh.limit)) && Number(fresh.limit) > 0
              ? Number(fresh.limit)
              : null,
            at: now,
            // Запоминаем показание нашего счётчика на момент опроса: разница
            // с текущим и есть то, что провайдер ещё не учёл.
            baseChars: local.chars,
          }
          writeJsonSetting(db, quotaKey(code), cache, now)
        }
      } catch (error) {
        // Недоступный /v2/usage не должен останавливать переводы: падаем
        // на локальный счётчик, он консервативнее (меньше или равен).
        console.error(`[translate] расход ${code} не получен: ${error.message}`)
      }
    }

    if (cache) {
      const sinceCheck = Math.max(0, local.chars - cache.baseChars)
      return {
        provider: code,
        used: cache.used + sinceCheck,
        limit: cache.limit ?? configuredLimit(code),
        month: local.month,
        source: 'provider',
      }
    }

    return {
      provider: code,
      used: local.chars,
      limit: configuredLimit(code),
      month: local.month,
      source: 'local',
    }
  }

  /**
   * Хватит ли квоты на пачку. Неизвестный лимит означает «проверять нечем»,
   * и это разрешение: у MyMemory лимит суточный и в символах не выражен,
   * а запрещать по умолчанию значило бы никогда его не использовать.
   *
   * Проверка неатомарна и остаётся быстрым фильтром для выбора провайдера:
   * право на отправку даёт только reserve(). Живые удержания она всё же
   * учитывает — иначе реестр выбирал бы провайдера, у которого квота уже
   * расписана чужими пачками, и каждая такая пачка падала бы на reserve().
   *
   * @returns {Promise<{ok: true}|{ok: false, reason: string, used, limit}>}
   */
  const preflight = async (code, provider = null, options2 = {}) => {
    const { chars = 0, now = Date.now(), signal = null } = options2

    const state = await snapshot(code, provider, { now, signal })
    if (!state.limit) return { ok: true, used: state.used, limit: null }

    const held = heldChars(code, now)
    const ceiling = state.limit * safetyRatio
    if (state.used + held + Math.max(0, chars) > ceiling) {
      return { ok: false, reason: 'quota_exhausted', used: state.used + held, limit: state.limit }
    }
    return { ok: true, used: state.used + held, limit: state.limit }
  }

  /** Сброс кэша остатка — после смены ключа в админке он врёт. */
  const forget = (code, now = Date.now()) => {
    writeJsonSetting(db, quotaKey(code), { used: 0, limit: null, at: 0, baseChars: 0 }, now)
  }

  return {
    monthKey,
    readLocal,
    add,
    configuredLimit,
    snapshot,
    preflight,
    forget,
    reserve,
    commit,
    release,
    releaseOwned,
    reclaimExpired,
    heldChars,
  }
}
