// CR-033. `createPending` раньше опиралась на один только `idempotency_key`:
// любой повтор ключа возвращал прежнюю попытку, поэтому ключ, переиспользованный
// с другой заявкой, отдавал состояние чужой отправки. Проверяется пара
// «ключ + отпечаток полезной нагрузки» и то, что отпечаток действительно
// сохраняется в строке попытки — иначе повтор после рестарта не с чем сверять.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import {
  IdempotencyConflictError,
  createLeadRepository,
  leadPayloadFingerprint,
} from './leads.js'

const lead = { name: 'Test User', phone: '+998900000000', message: 'Test lead, ignore' }
const context = { ipHash: 'a'.repeat(64), userAgentHash: 'b'.repeat(64) }
const metadata = { locale: 'en', pagePath: '/' }
const key = '11111111-1111-4111-8111-111111111111'

describe('lead idempotency records (CR-033)', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  const create = (repository, overrides = {}) =>
    repository.createPending({ lead, context, metadata, idempotencyKey: key, ...overrides })

  it('stores the canonical fingerprint alongside the key', () => {
    const repository = createLeadRepository(db)
    create(repository)

    const row = db.get('SELECT idempotency_key, payload_fingerprint FROM lead_delivery_attempts')
    expect(row.idempotency_key).toBe(key)
    expect(row.payload_fingerprint).toBe(leadPayloadFingerprint({ lead, metadata }))
    expect(row.payload_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('replays the stored attempt for the same key and payload', () => {
    const repository = createLeadRepository(db)
    const first = create(repository)
    const second = create(repository)

    expect(first).toMatchObject({ created: true, replay: false })
    expect(second).toMatchObject({ created: false, replay: true, leadId: first.leadId })
    expect(db.get('SELECT COUNT(*) AS n FROM leads').n).toBe(1)
  })

  it('treats cosmetic differences in the same lead as a replay', () => {
    const repository = createLeadRepository(db)
    const first = create(repository)
    const second = create(repository, {
      lead: { name: '  TEST   user ', phone: '998 90 000 00 00', message: 'Test lead,  ignore' },
    })

    expect(second).toMatchObject({ created: false, replay: true, leadId: first.leadId })
  })

  it('refuses a reused key that carries a different payload', () => {
    const repository = createLeadRepository(db)
    create(repository)

    expect(() => create(repository, { lead: { ...lead, phone: '+998900000001' } })).toThrow(
      IdempotencyConflictError
    )
    expect(() => create(repository, { metadata: { locale: 'ru', pagePath: '/' } })).toThrow(
      /idempotency_conflict/
    )
    expect(db.get('SELECT COUNT(*) AS n FROM leads').n).toBe(1)
    expect(db.get('SELECT COUNT(*) AS n FROM lead_delivery_attempts').n).toBe(1)
  })

  it('refuses a key whose row predates fingerprinting', () => {
    const repository = createLeadRepository(db)
    create(repository)
    db.run('UPDATE lead_delivery_attempts SET payload_fingerprint = NULL')

    expect(() => create(repository)).toThrow(IdempotencyConflictError)
  })

  it('replays across a process restart over the same database', () => {
    const created = create(createLeadRepository(db))
    // Новый экземпляр репозитория — единственное состояние идемпотентности
    // живёт в базе, в памяти процесса ничего не остаётся.
    const replayed = create(createLeadRepository(db))

    expect(replayed).toMatchObject({ created: false, replay: true, leadId: created.leadId })
    expect(db.get('SELECT COUNT(*) AS n FROM leads').n).toBe(1)
  })

  it('leaves the first lead untouched after a conflict and still replays it', () => {
    const repository = createLeadRepository(db)
    const first = create(repository)

    expect(() => create(repository, { lead: { ...lead, name: 'Other User' } })).toThrow(
      IdempotencyConflictError
    )
    expect(db.get('SELECT name FROM leads').name).toBe(lead.name)
    expect(create(repository)).toMatchObject({ replay: true, leadId: first.leadId })
  })
})
