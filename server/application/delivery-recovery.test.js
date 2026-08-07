// CR-032. Сценарий, ради которого написана служба: Telegram принял сообщение,
// после чего упали ОБЕ локальные фиксации подряд. Долговечная попытка остаётся
// в `sending`, retry навсегда отвечает `delivery_in_progress`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createDeliveryRecoveryService } from './delivery-recovery.js'
import { createLeadDeliveryService } from './lead-delivery.js'

const lead = { name: 'Test User', phone: '+998900000000', message: 'Test lead, ignore' }
const context = { ipHash: 'a'.repeat(64), userAgentHash: 'b'.repeat(64) }
const metadata = { locale: 'en', pagePath: '/' }
const telegram = { botToken: 't', chatId: 'c', apiBase: 'https://telegram.invalid' }

describe('stranded delivery recovery (CR-032)', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  /**
   * Воспроизводит отказ обеих фиксаций после успеха Telegram.
   * Первый `finalize` (`sent`) и второй (`delivery_unknown`) бросают, поэтому
   * строка остаётся ровно в том состоянии, ради которого написана служба.
   */
  const strandAttempt = async () => {
    const send = vi.fn(async () => ({ ok: true, definitive: true, responseCode: 200, messageId: 7 }))
    const service = createLeadDeliveryService({ db, telegramGateway: { send } })
    const failing = vi
      .spyOn(service.repository, 'finalize')
      .mockImplementation(() => {
        throw new Error('disk full')
      })

    const result = await service.submit({
      lead,
      context,
      metadata,
      idempotencyKey: 'stranded-key-0001',
      telegram,
      text: 'fixture',
    })

    expect(result).toMatchObject({ state: 'delivery_unknown' })
    expect(failing).toHaveBeenCalledTimes(2)
    failing.mockRestore()
    return { send, service }
  }

  it('leaves the attempt stranded in sending when both finalize writes fail', async () => {
    await strandAttempt()
    expect(db.get('SELECT state FROM lead_delivery_attempts').state).toBe('sending')
  })

  it('blocks retry forever until recovery runs', async () => {
    const { service } = await strandAttempt()
    const leadId = db.get('SELECT id FROM leads').id

    await expect(
      service.retry({
        leadId,
        idempotencyKey: 'retry-key-0001',
        telegram,
        textForLead: () => 'fixture',
      })
    ).resolves.toMatchObject({ error: 'delivery_in_progress' })
  })

  it('moves an expired sending attempt to delivery_unknown, never to failed', async () => {
    await strandAttempt()
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    const recovery = createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} })

    expect(recovery.run({ at: started + 59_000 }).recovered).toBe(0)
    expect(recovery.run({ at: started + 61_000 })).toMatchObject({ recovered: 1, scanned: 1 })

    const attempt = db.get('SELECT state, recovery_reason, recovered_at FROM lead_delivery_attempts')
    expect(attempt.state).toBe('delivery_unknown')
    expect(attempt.recovery_reason).toBe('stale_sending_ttl_expired')
    expect(attempt.recovered_at).toBe(started + 61_000)
    expect(db.get('SELECT delivery_state FROM leads').delivery_state).toBe('delivery_unknown')
  })

  it('performs the transition exactly once across two recovery runs', async () => {
    await strandAttempt()
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    const recovery = createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} })

    const first = recovery.run({ at: started + 61_000 })
    const second = recovery.run({ at: started + 62_000 })

    expect(first.recovered).toBe(1)
    expect(second.recovered).toBe(0)
    expect(recovery.countRecovered()).toBe(1)
    // Момент восстановления принадлежит первому проходу.
    expect(db.get('SELECT recovered_at FROM lead_delivery_attempts').recovered_at).toBe(
      started + 61_000
    )
  })

  it('refuses to recover while another process holds the lease', async () => {
    await strandAttempt()
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    const at = started + 61_000
    db.run(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('delivery.recovery.lease', ?, ?)`,
      [JSON.stringify({ owner: 'other-process', until: at + 30_000 }), at]
    )

    const recovery = createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} })
    expect(recovery.run({ at })).toMatchObject({ lease: 'busy', recovered: 0 })
    expect(db.get('SELECT state FROM lead_delivery_attempts').state).toBe('sending')
  })

  it('takes over an expired lease', async () => {
    await strandAttempt()
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    const at = started + 61_000
    db.run(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('delivery.recovery.lease', ?, ?)`,
      [JSON.stringify({ owner: 'dead-process', until: at - 1 }), at]
    )

    const recovery = createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} })
    expect(recovery.run({ at }).recovered).toBe(1)
  })

  it('does not overwrite a terminal state written by a late finalize', async () => {
    await strandAttempt()
    const attemptId = db.get('SELECT id FROM lead_delivery_attempts').id
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    const recovery = createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} })

    // Обработчик доставки успел дописать подтверждённый успех.
    db.run("UPDATE lead_delivery_attempts SET state = 'sent', finished_at = ? WHERE id = ?", [
      started + 100,
      attemptId,
    ])
    db.run("UPDATE leads SET delivery_state = 'sent'")

    expect(recovery.recoverOne(attemptId, started + 61_000)).toBe(false)
    expect(db.get('SELECT state FROM lead_delivery_attempts').state).toBe('sent')
    expect(db.get('SELECT delivery_state FROM leads').delivery_state).toBe('sent')
  })

  it('still requires explicit confirmation before retrying a recovered lead', async () => {
    const { service } = await strandAttempt()
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} }).run({ at: started + 61_000 })
    const leadId = db.get('SELECT id FROM leads').id

    await expect(
      service.retry({
        leadId,
        idempotencyKey: 'retry-key-0002',
        telegram,
        textForLead: () => 'fixture',
      })
    ).resolves.toMatchObject({ error: 'delivery_unknown_requires_confirmation' })
  })

  it('allows a confirmed retry after recovery and creates exactly one new attempt', async () => {
    const { service } = await strandAttempt()
    const started = db.get('SELECT started_at FROM lead_delivery_attempts').started_at
    createDeliveryRecoveryService({ db, ttlMs: 60_000, warn: () => {} }).run({ at: started + 61_000 })
    const leadId = db.get('SELECT id FROM leads').id

    const retried = await service.retry({
      leadId,
      idempotencyKey: 'retry-key-0003',
      confirmUnknown: true,
      telegram,
      textForLead: () => 'fixture',
    })

    expect(retried).toMatchObject({ ok: true, state: 'sent' })
    expect(db.get('SELECT COUNT(*) AS n FROM lead_delivery_attempts').n).toBe(2)
  })

  it('scans stale attempts through the dedicated index', () => {
    const plan = db
      .all(
        `EXPLAIN QUERY PLAN
         SELECT id FROM lead_delivery_attempts
          WHERE state IN ('pending', 'sending')
            AND COALESCE(started_at, created_at) < ?`,
        [0]
      )
      .map((row) => row.detail)
      .join(' ')

    expect(plan).toContain('lead_delivery_stale_idx')
  })
})
