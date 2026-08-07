// CR-052: every system state has to exist in every supported language, and a
// raw backend code must never become the sentence a visitor reads.
//
// The bundles are read from disk rather than imported through i18next: the
// question here is what ships in public/locales, not what a configured i18n
// instance would resolve at runtime.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  FRONTEND_ERROR_CODES,
  errorActionKey,
  errorMessageKey,
  frontendError,
} from './errors.js'

const LANGUAGES = ['ru', 'en', 'uz', 'tr', 'ar']

const bundle = (language) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../public/locales/${language}/translation.json`, import.meta.url)),
      'utf8'
    )
  )

const BUNDLES = Object.fromEntries(LANGUAGES.map((language) => [language, bundle(language)]))

/** Value at a dotted key, or undefined. */
const at = (object, key) =>
  key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), object)

/** Every leaf key of a bundle, dotted. */
const keysOf = (object, prefix = '') =>
  Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`]
  )

/** Translator backed by one bundle, shaped like the i18next `t` we pass around. */
const translatorFor = (language) => (key, options) => {
  const value = at(BUNDLES[language], key)
  return typeof value === 'string' ? value : options?.defaultValue ?? key
}

// System states listed in CR-052 that are not part of the error catalogue.
const SYSTEM_KEYS = [
  'system.checking',
  'system.loadingPanel',
  'system.retry',
  'system.reload',
  'system.home',
  'system.notFound.title',
  'system.notFound.text',
  'system.unavailable.title',
  'system.unavailable.text',
  'system.chunkFailed.title',
  'system.chunkFailed.text',
  'system.diagnostic.summary',
  'system.diagnostic.code',
  'system.diagnostic.requestId',
  'system.diagnostic.time',
  'system.diagnostic.hint',
  'lang.label',
  'lang.current',
  'lang.switching',
]

describe('localized system states', () => {
  it('ships the same key set in all five bundles', () => {
    const reference = keysOf(BUNDLES.ru).sort()
    for (const language of LANGUAGES) {
      expect(keysOf(BUNDLES[language]).sort(), `bundle ${language}`).toEqual(reference)
    }
  })

  it.each(LANGUAGES)('%s translates every system state', (language) => {
    for (const key of SYSTEM_KEYS) {
      const value = at(BUNDLES[language], key)
      expect(typeof value, `${language}:${key}`).toBe('string')
      expect(value.trim(), `${language}:${key}`).not.toBe('')
    }
  })

  it.each(LANGUAGES)('%s carries a message and an action for every error code', (language) => {
    for (const code of FRONTEND_ERROR_CODES) {
      for (const key of [errorMessageKey(code), errorActionKey(code)]) {
        const value = at(BUNDLES[language], key)
        expect(typeof value, `${language}:${key}`).toBe('string')
        expect(value.trim(), `${language}:${key}`).not.toBe('')
        // An untranslated bundle usually shows up as the key itself or as a
        // copy of the Russian source; both are caught below.
        expect(value, `${language}:${key}`).not.toBe(key)
      }
    }
  })

  it.each(LANGUAGES.filter((language) => language !== 'ru'))(
    '%s does not fall back to the Russian text',
    (language) => {
      for (const code of FRONTEND_ERROR_CODES) {
        for (const key of [errorMessageKey(code), errorActionKey(code)]) {
          expect(at(BUNDLES[language], key), `${language}:${key}`).not.toBe(at(BUNDLES.ru, key))
        }
      }
      for (const key of SYSTEM_KEYS) {
        expect(at(BUNDLES[language], key), `${language}:${key}`).not.toBe(at(BUNDLES.ru, key))
      }
    }
  )

  it.each(LANGUAGES)('%s builds a message and an action for every code', (language) => {
    const t = translatorFor(language)
    for (const code of FRONTEND_ERROR_CODES) {
      const model = frontendError({ code }, { t })
      expect(model, `${language}:${code}`).toMatchObject({ code, technicalCode: code })
      expect(model.message).toBe(at(BUNDLES[language], errorMessageKey(code)))
      expect(model.action).toBe(at(BUNDLES[language], errorActionKey(code)))
    }
  })

  it.each(LANGUAGES)('%s never shows the raw backend code as the message', (language) => {
    const t = translatorFor(language)
    const raw = ['csrf_mismatch', 'telegram_unreachable', 'unsupported_mime', 'ECONNABORTED']
    for (const technicalCode of raw) {
      const model = frontendError({ code: technicalCode, requestId: 'req-42' }, { t })
      expect(model.technicalCode).toBe(technicalCode)
      expect(model.requestId).toBe('req-42')
      expect(model.message).not.toContain(technicalCode)
      expect(model.message).not.toContain('req-42')
      expect(model.action).not.toContain(technicalCode)
      expect(model.message.trim()).not.toBe('')
    }
  })

  it.each(LANGUAGES)('%s localizes the unknown-code fallback', (language) => {
    const t = translatorFor(language)
    const model = frontendError({ code: 'brand_new_server_code' }, { t })
    expect(model.code).toBe('server_error')
    expect(model.technicalCode).toBe('brand_new_server_code')
    expect(model.message).toBe(at(BUNDLES[language], 'errors.fallback.message'))
    expect(model.action).toBe(at(BUNDLES[language], errorActionKey('server_error')))
  })

  it('keeps the Russian defaults when no translator is given', () => {
    const model = frontendError({ code: 'network_error' })
    expect(model.message).toBe(at(BUNDLES.ru, errorMessageKey('network_error')))
    expect(model.action).toBe(at(BUNDLES.ru, errorActionKey('network_error')))
  })

  it('prefers an explicit caller fallback over the translated one', () => {
    const t = translatorFor('en')
    const model = frontendError({ code: 'brand_new_server_code' }, { t, fallback: 'Custom text' })
    expect(model.message).toBe('Custom text')
  })

  it('survives a translator that throws or returns a non-string', () => {
    const throwing = () => {
      throw new Error('i18n not ready')
    }
    expect(frontendError({ code: 'network_error' }, { t: throwing }).message).toBe(
      at(BUNDLES.ru, errorMessageKey('network_error'))
    )
    expect(frontendError({ code: 'network_error' }, { t: () => ({}) }).message).toBe(
      at(BUNDLES.ru, errorMessageKey('network_error'))
    )
    // i18next returns the key itself when nothing matches.
    expect(
      frontendError({ code: 'network_error' }, { t: (key) => key }).message
    ).toBe(at(BUNDLES.ru, errorMessageKey('network_error')))
  })
})
