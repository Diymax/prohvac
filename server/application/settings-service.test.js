import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SETTING_KEYS } from '../../shared/settings.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createSettingsService } from './settings-service.js'

const DEEPL_KEY = 'unit-deepl-service-value'

describe('settings service', () => {
  let db
  // Counts full table reads so the revision cache can be observed from outside.
  let fullReads
  let connection

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    fullReads = 0
    connection = {
      ...db,
      all: (sql, params) => {
        if (sql.includes('FROM settings')) fullReads += 1
        return db.all(sql, params)
      },
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  const save = (service, key, value) => {
    const checked = service.validate(key, value)
    expect(checked.ok).toBe(true)
    return service.write(key, checked)
  }

  it('reads back exactly the value that was written', () => {
    const service = createSettingsService(connection)

    save(service, SETTING_KEYS.LEAD_RATE_MAX, 17)
    save(service, SETTING_KEYS.SEO_TITLE, 'Service SEO title')
    save(service, SETTING_KEYS.FORM_REQUIRE_MESSAGE, true)

    expect(service.read(SETTING_KEYS.LEAD_RATE_MAX)).toBe(17)
    expect(service.read(SETTING_KEYS.SEO_TITLE)).toBe('Service SEO title')
    expect(service.read(SETTING_KEYS.FORM_REQUIRE_MESSAGE)).toBe(true)
    // Untouched keys fall back to the schema default rather than disappearing.
    expect(service.read(SETTING_KEYS.SEO_DESCRIPTION)).toBe('')
  })

  it('rejects an unknown key instead of returning undefined', () => {
    const service = createSettingsService(connection)
    expect(() => service.read('nope.not_a_setting')).toThrow(TypeError)
  })

  it('caches the snapshot per revision and drops it on a local write', () => {
    const service = createSettingsService(connection)

    const first = service.snapshot()
    const second = service.snapshot()
    expect(second).toBe(first)
    expect(fullReads).toBe(1)

    save(service, SETTING_KEYS.LEAD_RATE_MAX, 23)

    const third = service.snapshot()
    expect(third).not.toBe(first)
    expect(third.revision).not.toBe(first.revision)
    expect(third.values[SETTING_KEYS.LEAD_RATE_MAX]).toBe(23)
    expect(fullReads).toBe(2)

    // No write, no re-read: the revision is unchanged.
    service.snapshot()
    expect(fullReads).toBe(2)
  })

  it('drops the cache when another process writes the table', () => {
    const service = createSettingsService(connection)
    expect(service.snapshot().values[SETTING_KEYS.SEO_TITLE]).toBe('')
    expect(fullReads).toBe(1)

    // A neighbouring process of the pool shares nothing but the database, so
    // the revision has to be derived from the table itself.
    db.run(
      `INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)`,
      [SETTING_KEYS.SEO_TITLE, 'Written elsewhere', Date.now() + 1]
    )

    expect(service.snapshot().values[SETTING_KEYS.SEO_TITLE]).toBe('Written elsewhere')
    expect(fullReads).toBe(2)
  })

  it('returns an immutable snapshot', () => {
    const service = createSettingsService(connection)
    const { values } = service.snapshot()
    expect(() => {
      values[SETTING_KEYS.SEO_TITLE] = 'mutated'
    }).toThrow(TypeError)
  })

  it('falls back to defaults while the table cannot be read', () => {
    const failing = {
      ...db,
      get: () => {
        throw new Error('database is locked')
      },
      all: () => {
        throw new Error('database is locked')
      },
    }
    const service = createSettingsService(failing)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(service.snapshot().revision).toBeNull()
    expect(service.read(SETTING_KEYS.LEAD_RATE_MAX)).toBe(5)
    expect(errors).toHaveBeenCalled()
  })

  it('never serves a secret from the cache', () => {
    const service = createSettingsService(connection)
    save(service, SETTING_KEYS.DEEPL_API_KEY, DEEPL_KEY)

    expect(service.read(SETTING_KEYS.DEEPL_API_KEY)).toBe(DEEPL_KEY)
    // Warm the plain-value cache; the secret must not ride along with it.
    service.snapshot()

    // Damaging the ciphertext without touching updated_at leaves the revision
    // unchanged on purpose: a cached secret would still authenticate here.
    const row = db.get('SELECT value_ct FROM settings WHERE key = ?', [SETTING_KEYS.DEEPL_API_KEY])
    const corrupt = Buffer.from(row.value_ct)
    corrupt[0] ^= 0xff
    db.run('UPDATE settings SET value_ct = ? WHERE key = ?', [corrupt, SETTING_KEYS.DEEPL_API_KEY])

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(service.read(SETTING_KEYS.DEEPL_API_KEY)).toBe('')
    expect(warning.mock.calls.flat().join(' ')).toContain('ciphertext_auth_failed')
  })

  it('keeps the secret out of the admin listing', () => {
    const service = createSettingsService(connection)
    save(service, SETTING_KEYS.DEEPL_API_KEY, DEEPL_KEY)

    const items = service.list()
    const item = items.find((candidate) => candidate.key === SETTING_KEYS.DEEPL_API_KEY)
    expect(item).toMatchObject({ isSecret: true, isSet: true })
    expect(item.value).toBeUndefined()
    expect(JSON.stringify(items)).not.toContain(DEEPL_KEY)
  })

  it('advances the content generation only for public content keys', () => {
    const service = createSettingsService(connection)
    const generation = () =>
      Number(db.get(`SELECT value FROM app_state WHERE key = 'content_generation'`)?.value ?? 0)

    save(service, SETTING_KEYS.LEAD_RATE_MAX, 11)
    expect(generation()).toBe(0)

    save(service, SETTING_KEYS.SEO_TITLE, 'Published title')
    expect(generation()).toBe(1)
  })

  it('runs the caller audit inside the write transaction', () => {
    const service = createSettingsService(connection)
    const checked = service.validate(SETTING_KEYS.SEO_TITLE, 'Rolled back')
    const failing = () => {
      throw new Error('audit exploded')
    }

    expect(() => service.write(SETTING_KEYS.SEO_TITLE, checked, { onWrite: failing })).toThrow(
      'audit exploded'
    )
    expect(db.get('SELECT key FROM settings WHERE key = ?', [SETTING_KEYS.SEO_TITLE])).toBeUndefined()
  })

  it('removes a secret when an empty value is submitted', () => {
    const service = createSettingsService(connection)
    save(service, SETTING_KEYS.DEEPL_API_KEY, DEEPL_KEY)

    const removed = save(service, SETTING_KEYS.DEEPL_API_KEY, '')
    expect(removed).toMatchObject({ isSecret: true, isSet: false, wasSet: true })
    expect(service.read(SETTING_KEYS.DEEPL_API_KEY)).toBe('')
  })
})
