import { createHash } from 'node:crypto'

import {
  ATTRIBUTION_KEYS,
  canonicalLeadPayload,
  normalizeLeadAttribution,
} from '../../shared/lead.js'

// СРОК ХРАНЕНИЯ ЗАПИСЕЙ ИДЕМПОТЕНТНОСТИ.
// Отдельного срока у них нет: ключ и отпечаток живут в строке
// lead_delivery_attempts, а она удаляется вместе с заявкой по внешнему ключу
// ON DELETE CASCADE. Заявку физически удаляет gcLeads() по наступившему
// leads.purge_after, то есть окно повтора равно сроку хранения персональных
// данных — 365 дней с момента приёма. Отдельная чистка ключей была бы вредна:
// пережившая заявку запись отвечала бы «повтор» на несуществующие данные,
// а исчезнувшая раньше заявки — создавала бы дубль.
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000

const SQL_ATTEMPT_BY_KEY = `
  SELECT a.*, l.delivery_state, l.telegram_status
    FROM lead_delivery_attempts a
    JOIN leads l ON l.id = a.lead_id
   WHERE a.idempotency_key = ?
`

const numberId = (value) => Number(value)

/**
 * SHA-256 от канонической формы заявки.
 *
 * Отпечаток считается здесь, а не в вызывающем коде: репозиторий — последняя
 * точка перед записью, и правило «что считать той же заявкой» не должно
 * зависеть от того, какой маршрут привёл запрос.
 */
export const leadPayloadFingerprint = ({ lead, metadata } = {}) =>
  createHash('sha256')
    .update(
      canonicalLeadPayload({
        name: lead?.name,
        phone: lead?.phone,
        message: lead?.message,
        locale: metadata?.locale,
        pagePath: metadata?.pagePath,
      }),
      'utf8'
    )
    .digest('hex')

/**
 * Ключ идемпотентности переиспользован с другой заявкой.
 *
 * Сигнализируется исключением, а не полем результата: конфликт — это отказ
 * в приёме, а не исход доставки, и он не должен пройти по ветке повтора
 * и вернуть клиенту состояние чужой отправки.
 */
export class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency_conflict')
    this.name = 'IdempotencyConflictError'
    this.code = 'idempotency_conflict'
  }
}

export const createLeadRepository = (db) => {
  const createPending = ({ lead, context, metadata, idempotencyKey, now = Date.now() }) => {
    // Отпечаток считается до транзакции: хеширование не должно удерживать
    // блокировку записи, а от состояния базы оно не зависит.
    const fingerprint = leadPayloadFingerprint({ lead, metadata })

    return db.transaction(() => {
      const existing = db.get(SQL_ATTEMPT_BY_KEY, [idempotencyKey])
      if (existing) {
        // NULL у строк, созданных до CR-033 и повторами из админки, тоже
        // считается несовпадением: подтвердить, что это та же заявка, нечем.
        if (existing.payload_fingerprint !== fingerprint) throw new IdempotencyConflictError()
        return { created: false, replay: true, leadId: existing.lead_id, attempt: existing }
      }

      // Атрибуция раскладывается по ATTRIBUTION_KEYS, а не перечисляется
      // руками: нормализатор всегда возвращает полный набор ключей в том же
      // порядке, поэтому колонки и параметры не могут разъехаться.
      const attribution = normalizeLeadAttribution(metadata.attribution)
      const inserted = db.run(
        `INSERT INTO leads (
           created_at, name, phone, message, locale, page_path, ip_hash, ua_hash,
           telegram_status, delivery_state, status, purge_after,
           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
           yclid, gclid, ym_client_id, referrer
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 'new', ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          now,
          lead.name,
          lead.phone,
          lead.message || '',
          metadata.locale,
          metadata.pagePath,
          context.ipHash,
          context.userAgentHash,
          now + RETENTION_MS,
          ...ATTRIBUTION_KEYS.map((key) => attribution[key]),
        ]
      )
      const leadId = numberId(inserted.lastInsertRowid)
      const attemptInfo = db.run(
        `INSERT INTO lead_delivery_attempts (
           lead_id, attempt_no, state, idempotency_key, payload_fingerprint, created_at
         ) VALUES (?, 1, 'pending', ?, ?, ?)`,
        [leadId, idempotencyKey, fingerprint, now]
      )
      return {
        created: true,
        replay: false,
        leadId,
        attempt: db.get('SELECT * FROM lead_delivery_attempts WHERE id = ?', [
          numberId(attemptInfo.lastInsertRowid),
        ]),
      }
    })
  }

  const markSending = (attemptId, now = Date.now()) =>
    db.transaction(() => {
      const changed = db.run(
        `UPDATE lead_delivery_attempts
            SET state = 'sending', started_at = ?
          WHERE id = ? AND state = 'pending'`,
        [now, attemptId]
      )
      if (Number(changed.changes) !== 1) return false
      db.run(
        `UPDATE leads
            SET delivery_state = 'sending', telegram_status = 'pending', telegram_error = NULL
          WHERE id = (SELECT lead_id FROM lead_delivery_attempts WHERE id = ?)`,
        [attemptId]
      )
      return true
    })

  const finalize = (attemptId, outcome, now = Date.now()) =>
    db.transaction(() => {
      const row = db.get('SELECT lead_id, state FROM lead_delivery_attempts WHERE id = ?', [attemptId])
      if (!row) throw new Error('delivery_attempt_missing')
      if (row.state !== 'sending') {
        if (row.state === outcome.state) return row
        throw new Error(`delivery_transition_${row.state}_to_${outcome.state}`)
      }

      const changed = db.run(
        `UPDATE lead_delivery_attempts
            SET state = ?, finished_at = ?, response_code = ?, safe_error = ?,
                telegram_message_id = ?
          WHERE id = ? AND state = 'sending'`,
        [
          outcome.state,
          now,
          outcome.responseCode ?? null,
          outcome.safeError ?? null,
          outcome.messageId ?? null,
          attemptId,
        ]
      )
      if (Number(changed.changes) !== 1) throw new Error('delivery_transition_conflict')

      const legacyStatus =
        outcome.state === 'sent' ? 'sent' : outcome.state === 'failed' ? 'failed' : 'pending'
      db.run(
        `UPDATE leads
            SET delivery_state = ?, telegram_status = ?, telegram_message_id = ?,
                telegram_error = ?,
                -- Чат запоминается ТОЛЬКО при удачной отправке и только если
                -- он известен: перезаписать его при неудаче значило бы потерять
                -- адрес прежней карточки, которую ещё можно отредактировать.
                telegram_chat_id = COALESCE(?, telegram_chat_id)
          WHERE id = ?`,
        [
          outcome.state,
          legacyStatus,
          outcome.messageId ?? null,
          outcome.safeError ?? null,
          outcome.state === 'sent' && outcome.chatId ? String(outcome.chatId) : null,
          row.lead_id,
        ]
      )
      return db.get('SELECT * FROM lead_delivery_attempts WHERE id = ?', [attemptId])
    })

  const claimRetry = ({
    leadId,
    idempotencyKey,
    actorUserId,
    force = false,
    confirmUnknown = false,
    now = Date.now(),
  }) =>
    db.transaction(() => {
      const duplicate = db.get(SQL_ATTEMPT_BY_KEY, [idempotencyKey])
      if (duplicate) return { ok: true, duplicate: true, attempt: duplicate }

      const lead = db.get(
        `SELECT id, created_at, name, phone, message, locale, delivery_state,
                telegram_message_id, status
           FROM leads WHERE id = ?`,
        [leadId]
      )
      if (!lead) return { ok: false, error: 'lead_not_found' }

      const latest = db.get(
        `SELECT * FROM lead_delivery_attempts
          WHERE lead_id = ? ORDER BY attempt_no DESC LIMIT 1`,
        [leadId]
      )
      if (latest && (latest.state === 'pending' || latest.state === 'sending')) {
        return { ok: false, error: 'delivery_in_progress' }
      }
      if (latest?.state === 'sent' && !force) {
        return {
          ok: false,
          error: 'already_sent',
          telegramMessageId: latest.telegram_message_id,
        }
      }
      if (latest?.state === 'delivery_unknown' && !confirmUnknown) {
        return { ok: false, error: 'delivery_unknown_requires_confirmation' }
      }

      const attemptNo = Number(latest?.attempt_no ?? 0) + 1
      const inserted = db.run(
        `INSERT INTO lead_delivery_attempts (
           lead_id, attempt_no, state, started_at, idempotency_key,
           actor_user_id, created_at
         ) VALUES (?, ?, 'sending', ?, ?, ?, ?)`,
        [leadId, attemptNo, now, idempotencyKey, actorUserId ?? null, now]
      )
      db.run(
        `UPDATE leads
            SET delivery_state = 'sending', telegram_status = 'pending', telegram_error = NULL
          WHERE id = ?`,
        [leadId]
      )
      return {
        ok: true,
        duplicate: false,
        lead,
        attempt: db.get('SELECT * FROM lead_delivery_attempts WHERE id = ?', [
          numberId(inserted.lastInsertRowid),
        ]),
      }
    })

  // -------------------------------------------------------------------------
  // Статус заявки, изменённый из чата Telegram
  // -------------------------------------------------------------------------

  /**
   * Отмечает обновление Telegram как обработанное.
   *
   * Telegram повторяет доставку, пока не получит 200, и штатно присылает одно
   * и то же обновление несколько раз. Вставка с игнорированием конфликта — это
   * и есть проверка «видели ли мы его»: она атомарна, в отличие от пары
   * SELECT + INSERT, между которыми успевает пройти повтор.
   *
   * @returns {boolean} true — обновление новое и его надо обработать
   */
  const rememberUpdate = (updateId, now = Date.now()) => {
    const inserted = db.run(
      'INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)',
      [Number(updateId), now]
    )
    return Number(inserted.changes) === 1
  }

  /**
   * Меняет статус заявки от имени участника чата.
   *
   * Возвращает null, если заявки уже нет: срок хранения персональных данных
   * наступает сам, а карточка в чате живёт вечно, и нажатие на кнопку у давно
   * стёртой заявки — штатная ситуация, а не ошибка.
   *
   * @returns {{lead: object, changed: boolean}|null}
   */
  const applyStatusFromTelegram = ({ leadId, status, actor, now = Date.now() }) =>
    db.transaction(() => {
      const before = db.get(
        `SELECT id, status, telegram_chat_id, telegram_message_id
           FROM leads WHERE id = ?`,
        [leadId]
      )
      if (!before) return null

      if (before.status === status) return { lead: before, changed: false }

      db.run(
        `UPDATE leads
            SET status = ?, status_source = 'telegram', status_actor = ?,
                status_changed_at = ?
          WHERE id = ?`,
        [status, actor == null ? null : String(actor).slice(0, 64), now, leadId]
      )

      return { lead: db.get('SELECT * FROM leads WHERE id = ?', [leadId]), changed: true }
    })

  return {
    createPending,
    markSending,
    finalize,
    claimRetry,
    rememberUpdate,
    applyStatusFromTelegram,
    getAttemptByKey: (key) => db.get(SQL_ATTEMPT_BY_KEY, [key]),
  }
}
