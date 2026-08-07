// CR-052: no system state may ever paint a translation key on the screen,
// including the window before the locale bundle has arrived.

import { describe, expect, it } from 'vitest'

import { interpolate, localizedText } from './useLocalizedText.js'

const DEFAULTS = {
  'system.checking': 'Проверяем адрес…',
  'lang.current': 'Язык интерфейса: {{lang}}',
}

describe('localized text', () => {
  it('uses the translation when there is one', () => {
    const t = (key) => (key === 'system.checking' ? 'Checking the address…' : key)
    expect(localizedText(t, DEFAULTS, 'system.checking')).toBe('Checking the address…')
  })

  it('falls back to the default before the bundle is loaded', () => {
    // i18next returns the key itself while the bundle is still in flight.
    expect(localizedText((key) => key, DEFAULTS, 'system.checking')).toBe('Проверяем адрес…')
    expect(localizedText(null, DEFAULTS, 'system.checking')).toBe('Проверяем адрес…')
    expect(localizedText(() => '   ', DEFAULTS, 'system.checking')).toBe('Проверяем адрес…')
    expect(localizedText(() => 42, DEFAULTS, 'system.checking')).toBe('Проверяем адрес…')
  })

  it('survives a translator that throws', () => {
    const t = () => {
      throw new Error('i18n not initialised')
    }
    expect(localizedText(t, DEFAULTS, 'system.checking')).toBe('Проверяем адрес…')
  })

  it('interpolates the default as well', () => {
    expect(localizedText(null, DEFAULTS, 'lang.current', { lang: 'English' })).toBe(
      'Язык интерфейса: English'
    )
  })

  it('passes interpolation values to the translator', () => {
    const t = (key, options) => `${key}:${options.lang}`
    expect(localizedText(t, DEFAULTS, 'lang.current', { lang: 'Türkçe' })).toBe(
      'lang.current:Türkçe'
    )
  })

  it('returns the key when nothing else is known', () => {
    expect(localizedText(null, DEFAULTS, 'system.unknown')).toBe('system.unknown')
    expect(localizedText(null, undefined, 'system.unknown')).toBe('system.unknown')
  })

  it('leaves unknown placeholders alone', () => {
    expect(interpolate('a {{one}} b {{two}}', { one: '1' })).toBe('a 1 b {{two}}')
    expect(interpolate('plain')).toBe('plain')
  })
})
