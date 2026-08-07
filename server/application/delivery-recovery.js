// CR-032. Восстановление зависших попыток доставки.
//
// Telegram мог принять сообщение, после чего упали подряд обе локальные
// фиксации — и `sent`, и `delivery_unknown`. Долговечная строка остаётся
// в состоянии `sending`, а частичный уникальный индекс
// `lead_delivery_one_active_idx` запрещает завести новую попытку по этому
// лиду: заявка становится невосстановимой навсегда.
//
// ГЛАВНОЕ ПРАВИЛО. Такую попытку нельзя объявлять `failed`: внешняя система
// могла сообщение принять, и `failed` спровоцировал бы повторную отправку уже
// доставленного текста. Единственный допустимый исход — `delivery_unknown`,
// который требует явного подтверждения оператора перед retry.

const DEFAULT_TTL_MS = 5 * 60 * 1000
const LEASE_KEY = 'delivery.recovery.lease'
const DEFAULT_LEASE_MS = 60 * 1000
const RECOVERY_REASON = 'stale_sending_ttl_expired'

const readLease = (db) => {
  const row = db.get('SELECT value FROM app_state WHERE key = ?', [LEASE_KEY])
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    // Повреждённая запись аренды не должна блокировать восстановление
    // навсегда: считаем её отсутствующей и перезапишем своей.
    return null
  }
}

/**
 * Пытается захватить аренду восстановления.
 *
 * Аренда живёт в `app_state`, а не в памяти процесса: под Passenger рядом
 * работает несколько процессов из пула, и без общей блокировки они выполнили
 * бы один и тот же переход одновременно.
 *
 * @returns {string|null} Токен владельца или `null`, если аренду держит другой.
 */
const acquireLease = (db, { owner, now, leaseMs }) =>
  db.transaction(() => {
    const current = readLease(db)
    if (current && Number(current.until) > now && current.owner !== owner) return null

    db.run(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [LEASE_KEY, JSON.stringify({ owner, until: now + leaseMs }), now]
    )
    return owner
  })

const releaseLease = (db, owner) =>
  db.transaction(() => {
    const current = readLease(db)
    if (!current || current.owner !== owner) return false
    db.run('DELETE FROM app_state WHERE key = ?', [LEASE_KEY])
    return true
  })

/**
 * Служба восстановления зависших попыток доставки.
 *
 * @param {object} deps
 * @param {object} deps.db Соединение из `server/db`.
 * @param {number} [deps.ttlMs] Возраст, после которого `sending` считается зависшим.
 * @param {number} [deps.leaseMs] Срок аренды восстановления.
 * @param {() => number} [deps.now] Источник времени (для тестов).
 * @param {() => string} [deps.newOwner] Генератор идентификатора владельца.
 * @param {(message: string) => void} [deps.warn] Приёмник операционных предупреждений.
 */
export const createDeliveryRecoveryService = ({
  db,
  ttlMs = DEFAULT_TTL_MS,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => Date.now(),
  newOwner = () => crypto.randomUUID(),
  warn = (message) => console.warn(`[delivery-recovery] ${message}`),
}) => {
  if (!db?.transaction) throw new TypeError('delivery recovery requires a db connection')
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError('delivery recovery requires a positive ttlMs')
  }

  /** Попытки, зависшие дольше TTL. `started_at IS NULL` — строка, застрявшая в `pending`. */
  const listStale = (at = now()) =>
    db.all(
      `SELECT id, lead_id, attempt_no, state, started_at, created_at
         FROM lead_delivery_attempts
        WHERE state IN ('pending', 'sending')
          AND COALESCE(started_at, created_at) < ?
        ORDER BY COALESCE(started_at, created_at) ASC`,
      [at - ttlMs]
    )

  /**
   * Переводит одну попытку в `delivery_unknown`.
   *
   * UPDATE условный (`state IN ('pending','sending')`): если между выборкой и
   * записью попытку успел финализировать сам обработчик доставки — а именно
   * так выглядит «поздний finalize» — терминальное состояние остаётся за ним,
   * и восстановление ничего не переписывает.
   *
   * @returns {boolean} `true`, если переход выполнил именно этот вызов.
   */
  const recoverOne = (attemptId, at = now()) =>
    db.transaction(() => {
      const changed = db.run(
        `UPDATE lead_delivery_attempts
            SET state = 'delivery_unknown',
                finished_at = ?,
                recovered_at = ?,
                recovery_reason = ?,
                safe_error = COALESCE(safe_error, ?)
          WHERE id = ? AND state IN ('pending', 'sending')`,
        [at, at, RECOVERY_REASON, RECOVERY_REASON, attemptId]
      )
      if (Number(changed.changes) !== 1) return false

      // Лид ведём за попыткой, но только если он сам ещё не терминален:
      // подтверждённый `sent` понижать нельзя ни при каких условиях.
      db.run(
        `UPDATE leads
            SET delivery_state = 'delivery_unknown', telegram_status = 'pending'
          WHERE id = (SELECT lead_id FROM lead_delivery_attempts WHERE id = ?)
            AND delivery_state IN ('pending', 'sending')`,
        [attemptId]
      )
      return true
    })

  /**
   * Один проход восстановления под общей арендой.
   *
   * @returns {{recovered: number, scanned: number, skipped: number, lease: 'acquired'|'busy'}}
   */
  const run = ({ at = now() } = {}) => {
    const owner = newOwner()
    if (!acquireLease(db, { owner, now: at, leaseMs })) {
      return { recovered: 0, scanned: 0, skipped: 0, lease: 'busy' }
    }

    try {
      const stale = listStale(at)
      let recovered = 0
      for (const attempt of stale) {
        if (recoverOne(attempt.id, at)) recovered += 1
      }
      if (recovered > 0) {
        warn(
          `recovered ${recovered} stranded delivery attempt(s) to delivery_unknown ` +
          `(ttl=${ttlMs}ms); operator confirmation is required before any retry`
        )
      }
      return {
        recovered,
        scanned: stale.length,
        skipped: stale.length - recovered,
        lease: 'acquired',
      }
    } finally {
      releaseLease(db, owner)
    }
  }

  /** Число попыток, восстановленных службой. Для дашборда. */
  const countRecovered = () =>
    Number(
      db.get('SELECT COUNT(*) AS n FROM lead_delivery_attempts WHERE recovered_at IS NOT NULL')?.n ?? 0
    )

  return { run, listStale, recoverOne, countRecovered, ttlMs }
}

export const DELIVERY_RECOVERY_TTL_MS = DEFAULT_TTL_MS
export const DELIVERY_RECOVERY_REASON = RECOVERY_REASON
