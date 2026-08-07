import { describe, expect, it } from 'vitest'

import { SETTING_KEYS } from '../../shared/settings.js'
import { createRegistry } from './registry.js'

const provider = (code) => ({
  code,
  title: code,
  maxBatchTexts: 10,
  maxBatchChars: 1000,
  configFields: [],
  isConfigured: () => true,
  supports: () => true,
  toProviderLang: (lang) => lang,
  translate: async (texts) => ({ texts, billedChars: 0 }),
  usage: async () => null,
})

const usage = {
  preflight: async () => ({ ok: true }),
}

const dbWithRouting = (routing) => ({
  get: (sql, params) => {
    if (params?.[0] !== SETTING_KEYS.TRANSLATION_ROUTING) return undefined
    return { value: JSON.stringify(routing) }
  },
  run: () => ({}),
  transaction: (fn) => fn(),
})

describe('translation registry routing', () => {
  it('preserves explicit [] as a disabled route', async () => {
    const registry = createRegistry(
      dbWithRouting({ en: [], uz: ['mymemory'], tr: ['deepl'], ar: ['deepl'] }),
      { providers: [provider('deepl'), provider('mymemory')], usage }
    )

    expect(registry.routing().en).toEqual([])
    await expect(registry.pick('en')).resolves.toEqual({ provider: null, reason: 'no_route' })
  })

  it('supports ordered MyMemory routes and legacy scalar values', () => {
    const registry = createRegistry(
      dbWithRouting({
        en: 'mymemory',
        uz: ['mymemory', 'deepl'],
        tr: 'none',
        ar: ['deepl'],
      }),
      { providers: [provider('deepl'), provider('mymemory')], usage }
    )

    expect(registry.routing()).toEqual({
      en: ['mymemory'],
      uz: ['mymemory', 'deepl'],
      tr: [],
      ar: ['deepl'],
    })
  })
})
