import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LEGACY_SETTING_KEYS,
  SETTING_KEYS,
} from '../../shared/settings.js'
import { createSqliteDriver } from './driver.js'

let sqliteAvailable = true
try {
  createSqliteDriver(':memory:').close()
} catch {
  sqliteAvailable = false
}

const describeDb = sqliteAvailable ? describe : describe.skip
const migration = (name) =>
  readFileSync(join(import.meta.dirname, 'migrations', name), 'utf8').replace(/^\uFEFF/, '')

const SCHEMA = migration('001_init.sql')
const SETTINGS_REGISTRY_MIGRATION = migration('003_settings_registry.sql')

const insertSecret = (db, key, preview) => {
  db.run(
    `INSERT INTO settings
       (key, value, is_secret, value_ct, value_iv, value_tag, preview, updated_at)
     VALUES (?, NULL, 1, ?, ?, ?, ?, ?)`,
    [key, Buffer.from(`cipher-${preview}`), Buffer.alloc(12, 1), Buffer.alloc(16, 2), preview, 10]
  )
}

describeDb('003_settings_registry migration', () => {
  it('moves the legacy DeepL record to the canonical key', () => {
    const db = createSqliteDriver(':memory:')
    db.exec(SCHEMA)
    insertSecret(db, LEGACY_SETTING_KEYS.DEEPL_API_KEY, 'legacy')

    db.exec(SETTINGS_REGISTRY_MIGRATION)

    const canonical = db.get('SELECT * FROM settings WHERE key = ?', [
      SETTING_KEYS.DEEPL_API_KEY,
    ])
    expect(canonical.preview).toBe('legacy')
    expect(canonical.is_secret).toBe(1)
    expect(
      db.get('SELECT key FROM settings WHERE key = ?', [LEGACY_SETTING_KEYS.DEEPL_API_KEY])
    ).toBeUndefined()
    db.close()
  })

  it('keeps an existing canonical value and removes the ambiguous legacy row', () => {
    const db = createSqliteDriver(':memory:')
    db.exec(SCHEMA)
    insertSecret(db, SETTING_KEYS.DEEPL_API_KEY, 'canonical')
    insertSecret(db, LEGACY_SETTING_KEYS.DEEPL_API_KEY, 'legacy')

    db.exec(SETTINGS_REGISTRY_MIGRATION)

    expect(
      db.get('SELECT preview FROM settings WHERE key = ?', [SETTING_KEYS.DEEPL_API_KEY])
    ).toEqual({ preview: 'canonical' })
    expect(
      db.get('SELECT key FROM settings WHERE key = ?', [LEGACY_SETTING_KEYS.DEEPL_API_KEY])
    ).toBeUndefined()
    db.close()
  })

  it('backfills scalar routing to arrays and preserves explicit disabled arrays', () => {
    const db = createSqliteDriver(':memory:')
    db.exec(SCHEMA)
    db.run(
      `INSERT INTO settings (key, value, is_secret)
       VALUES (?, ?, 0)`,
      [
        SETTING_KEYS.TRANSLATION_ROUTING,
        JSON.stringify({ en: 'none', uz: 'mymemory', tr: [], ar: 'deepl' }),
      ]
    )

    db.exec(SETTINGS_REGISTRY_MIGRATION)

    const stored = db.get('SELECT value FROM settings WHERE key = ?', [
      SETTING_KEYS.TRANSLATION_ROUTING,
    ])
    expect(JSON.parse(stored.value)).toEqual({
      en: [],
      uz: ['mymemory'],
      tr: [],
      ar: ['deepl'],
    })
    db.close()
  })
})
