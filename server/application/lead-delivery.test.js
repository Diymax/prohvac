import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createLeadDeliveryService } from './lead-delivery.js'

const lead = {
  name: 'Test User',
  phone: '+998900000000',
  message: 'Test lead, ignore',
}
const context = {
  ipHash: 'a'.repeat(64),
  userAgentHash: 'b'.repeat(64),
}
const metadata = { locale: 'en', pagePath: '/' }
const telegram = {
  botToken: 'fixture-token',
  chatId: 'fixture-chat',
  apiBase: 'https://telegram.invalid',
}

describe('lead delivery state machine', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  const serviceWith = (result, customDb = db) => {
    const send = vi.fn(async () => result)
    return {
      send,
      service: createLeadDeliveryService({ db: customDb, telegramGateway: { send } }),
    }
  }

  const submit = (service, idempotencyKey = 'lead-attempt-0001') =>
    service.submit({
      lead,
      context,
      metadata,
      idempotencyKey,
      telegram,
      text: 'fixture-message',
    })

  it('persists pending -> sending -> sent with the external message id', async () => {
    const { service } = serviceWith({
      ok: true,
      definitive: true,
      responseCode: 200,
      messageId: 42,
    })
    await expect(submit(service)).resolves.toMatchObject({ ok: true, state: 'sent', messageId: 42 })
    expect(db.get('SELECT delivery_state, telegram_status FROM leads')).toEqual({
      delivery_state: 'sent',
      telegram_status: 'sent',
    })
    expect(
      db.get(
        `SELECT attempt_no, state, response_code, telegram_message_id
           FROM lead_delivery_attempts`
      )
    ).toEqual({
      attempt_no: 1,
      state: 'sent',
      response_code: 200,
      telegram_message_id: 42,
    })
  })

  it('stores a definitive Telegram rejection as failed', async () => {
    const { service } = serviceWith({
      ok: false,
      definitive: true,
      error: 'telegram_failed',
      responseCode: 400,
      description: 'bad request',
    })
    await expect(submit(service)).resolves.toMatchObject({
      ok: false,
      state: 'failed',
      error: 'telegram_failed',
    })
    expect(db.get('SELECT delivery_state FROM leads').delivery_state).toBe('failed')
  })

  it('stores an indeterminate transport failure as delivery_unknown', async () => {
    const { service } = serviceWith({
      ok: false,
      definitive: false,
      error: 'timeout',
      responseCode: null,
    })
    await expect(submit(service)).resolves.toMatchObject({
      ok: false,
      state: 'delivery_unknown',
      error: 'delivery_unknown',
    })
    expect(db.get('SELECT delivery_state, telegram_status FROM leads')).toEqual({
      delivery_state: 'delivery_unknown',
      telegram_status: 'pending',
    })
  })

  it('uses delivery_unknown when the local sent commit fails after Telegram success', async () => {
    let failSentFinalize = true
    const flakyDb = {
      ...db,
      run(sql, params) {
        if (
          failSentFinalize &&
          sql.includes('UPDATE lead_delivery_attempts') &&
          params?.[0] === 'sent'
        ) {
          failSentFinalize = false
          throw new Error('fixture-db-write-failure')
        }
        return db.run(sql, params)
      },
      transaction: (fn) => db.transaction(fn),
    }
    const { service } = serviceWith(
      { ok: true, definitive: true, responseCode: 200, messageId: 77 },
      flakyDb
    )
    await expect(submit(service)).resolves.toMatchObject({
      ok: false,
      state: 'delivery_unknown',
      error: 'delivery_unknown',
    })
    expect(db.get('SELECT delivery_state, telegram_status FROM leads')).toEqual({
      delivery_state: 'delivery_unknown',
      telegram_status: 'pending',
    })
    expect(db.get('SELECT state FROM lead_delivery_attempts').state).toBe('delivery_unknown')
  })

  it('deduplicates the same idempotency key without a second Telegram call', async () => {
    const { service, send } = serviceWith({
      ok: true,
      definitive: true,
      responseCode: 200,
      messageId: 91,
    })
    await submit(service, 'lead-idempotency-01')
    await expect(submit(service, 'lead-idempotency-01')).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      state: 'sent',
    })
    expect(send).toHaveBeenCalledOnce()
    expect(db.get('SELECT COUNT(*) AS n FROM leads').n).toBe(1)
    expect(db.get('SELECT COUNT(*) AS n FROM lead_delivery_attempts').n).toBe(1)
  })

  it('blocks retry of delivery_unknown without explicit confirmation', async () => {
    const unknown = serviceWith({
      ok: false,
      definitive: false,
      error: 'network_error',
    })
    await submit(unknown.service, 'lead-unknown-0001')
    const retry = serviceWith({
      ok: true,
      definitive: true,
      responseCode: 200,
      messageId: 10,
    })
    const result = await retry.service.retry({
      leadId: 1,
      idempotencyKey: 'lead-retry-00001',
      actorUserId: null,
      force: false,
      confirmUnknown: false,
      telegram,
      textForLead: () => 'fixture-message',
    })
    expect(result).toEqual({ ok: false, error: 'delivery_unknown_requires_confirmation' })
    expect(retry.send).not.toHaveBeenCalled()
  })

  it('allows only one parallel retry claim', async () => {
    const failed = serviceWith({
      ok: false,
      definitive: true,
      error: 'telegram_failed',
      responseCode: 500,
    })
    await submit(failed.service, 'lead-failed-00001')

    let release
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const service = createLeadDeliveryService({ db, telegramGateway: { send } })
    const first = service.retry({
      leadId: 1,
      idempotencyKey: 'parallel-retry-01',
      actorUserId: null,
      telegram,
      textForLead: () => 'fixture-message',
    })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const second = await service.retry({
      leadId: 1,
      idempotencyKey: 'parallel-retry-02',
      actorUserId: null,
      telegram,
      textForLead: () => 'fixture-message',
    })
    expect(second).toEqual({ ok: false, error: 'delivery_in_progress' })

    release({ ok: true, definitive: true, responseCode: 200, messageId: 123 })
    await expect(first).resolves.toMatchObject({ ok: true, state: 'sent' })
    expect(send).toHaveBeenCalledOnce()
  })
})
