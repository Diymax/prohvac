import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TRANSLATION_ROUTING,
  LEGACY_SETTING_KEYS,
  SECRET_STATE,
  SETTING_KEYS,
  SETTINGS_REGISTRY,
  inspectSecretSetting,
  normalizeTranslationRouting,
} from './settings.js'

describe('settings registry', () => {
  it('uses one canonical DeepL key and keeps the legacy name migration-only', () => {
    expect(SETTING_KEYS.DEEPL_API_KEY).toBe('translation.deepl.key')
    expect(LEGACY_SETTING_KEYS.DEEPL_API_KEY).toBe('deepl.api_key')
    expect(SETTINGS_REGISTRY[SETTING_KEYS.DEEPL_API_KEY]).toMatchObject({
      type: 'secret',
      managed: true,
      envFallback: 'DEEPL_API_KEY',
    })
    expect(SETTINGS_REGISTRY[LEGACY_SETTING_KEYS.DEEPL_API_KEY]).toBeUndefined()
  })

  it('canonicalizes legacy routing without losing explicit disabled routes', () => {
    const result = normalizeTranslationRouting({
      en: 'none',
      uz: 'mymemory',
      tr: ['deepl', 'mymemory', 'deepl'],
      ar: [],
    })

    expect(result).toEqual({
      ok: true,
      reason: null,
      value: {
        en: [],
        uz: ['mymemory'],
        tr: ['deepl', 'mymemory'],
        ar: [],
      },
    })
  })

  it('fills only missing languages from defaults and rejects unknown providers', () => {
    expect(normalizeTranslationRouting({ en: [] }).value).toEqual({
      ...DEFAULT_TRANSLATION_ROUTING,
      en: [],
    })
    expect(normalizeTranslationRouting({ en: ['unknown'] })).toMatchObject({ ok: false })
  })
})

describe('inspectSecretSetting', () => {
  const completeRow = {
    value: null,
    is_secret: 1,
    value_ct: new Uint8Array([1]),
    value_iv: new Uint8Array(12),
    value_tag: new Uint8Array(16),
  }

  it('distinguishes absent, complete and structurally corrupt records', () => {
    expect(inspectSecretSetting(null).state).toBe(SECRET_STATE.ABSENT)
    expect(inspectSecretSetting(completeRow).state).toBe(SECRET_STATE.COMPLETE)
    expect(
      inspectSecretSetting({ ...completeRow, value_iv: new Uint8Array(11) }).state
    ).toBe(SECRET_STATE.CORRUPT)
    expect(inspectSecretSetting({ ...completeRow, value: 'plaintext' }).state).toBe(
      SECRET_STATE.CORRUPT
    )
  })

  it('authenticates ciphertext and reports only a closed corruption reason', () => {
    const warn = vi.fn()
    const result = inspectSecretSetting(completeRow, {
      decrypt: () => {
        throw new Error('sensitive decrypt detail')
      },
      warn,
    })

    expect(result).toEqual({
      state: SECRET_STATE.CORRUPT,
      reason: 'ciphertext_auth_failed',
      value: null,
    })
    expect(warn).toHaveBeenCalledWith('ciphertext_auth_failed')
    expect(JSON.stringify(result)).not.toContain('sensitive decrypt detail')
  })

  it('returns decrypted material only to the server caller that requested it', () => {
    expect(inspectSecretSetting(completeRow).value).toBeNull()
    expect(inspectSecretSetting(completeRow, { decrypt: () => 'stored-value' })).toEqual({
      state: SECRET_STATE.COMPLETE,
      reason: null,
      value: 'stored-value',
    })
  })
})
