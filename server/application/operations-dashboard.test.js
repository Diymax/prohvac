import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { buildOperationsDashboard } from './operations-dashboard.js'

describe('operations dashboard', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
  })

  afterEach(() => db.close())

  it('returns actionable aggregates without PII or secrets', () => {
    db.prepare(
      `INSERT INTO leads
        (name, phone, locale, page_path, ip_hash, delivery_state, telegram_status, status, purge_after)
       VALUES ('Private Name', '+998901234567', 'ru', '/', ?, 'delivery_unknown', 'pending', 'new', ?)`
    ).run('a'.repeat(64), Date.now() + 1000)

    const value = buildOperationsDashboard({
      db,
      user: { role: 'admin' },
      telegram: { enabled: true, botToken: 'secret', chatId: '1' },
      translateStatus: () => ({ queued: 2, failed: 1 }),
      mediaQuotaBytes: 1000,
      now: 10,
    })

    expect(value.leads).toEqual({
      new: 1,
      failed: 0,
      deliveryUnknown: 1,
      // CR-032: восстановленные и всё ещё зависшие попытки — отдельные счётчики.
      recovered: 0,
      stranded: 0,
    })
    expect(value.telegram).toEqual({ enabled: true, ready: true })
    expect(value.translations).toMatchObject({ queued: 2, failed: 1 })
    expect(JSON.stringify(value)).not.toContain('Private Name')
    expect(JSON.stringify(value)).not.toContain('secret')
  })

  it('filters sensitive operational data by server capabilities', () => {
    const value = buildOperationsDashboard({
      db,
      user: { role: 'viewer' },
      telegram: { enabled: false },
      translateStatus: () => ({}),
      mediaQuotaBytes: 1000,
      runtimeStatus: { state: 'ready' },
      now: 10,
    })

    expect(value.leads).toBeDefined()
    expect(value.media).toBeDefined()
    expect(value.security).toBeUndefined()
    expect(value.runtime).toBeUndefined()
    expect(value.disk).toBeUndefined()
  })
})
