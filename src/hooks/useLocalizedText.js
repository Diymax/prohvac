// Translation helper with guaranteed defaults.
//
// Locale bundles are fetched over HTTP and react-i18next runs with
// useSuspense: false, so the first render happens before any translation
// exists. A bare t('system.checking') would paint the raw key on the screen,
// which is exactly the kind of technical leak CR-052 forbids. Every caller
// therefore passes a table of defaults; it doubles as the documentation of
// the wording the five bundles are expected to carry.

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

/**
 * Fills {{name}} placeholders in a default text.
 *
 * i18next interpolates the values it receives, but the default is also used
 * when no translator is available at all, and an unreplaced {{lang}} in an
 * accessible name is worse than no name.
 *
 * @param {string} text
 * @param {object} [vars]
 * @returns {string}
 */
export const interpolate = (text, vars) =>
  String(text).replace(PLACEHOLDER, (match, name) =>
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  )

/**
 * Resolves a single key against a translator and a table of defaults.
 *
 * Pure on purpose: the fallback rules are the part worth testing, and they
 * must be testable without a DOM.
 *
 * @param {Function|null} t translator, normally i18next `t`
 * @param {Record<string, string>} defaults key → text used when translation is missing
 * @param {string} key
 * @param {object} [vars] interpolation values
 * @returns {string}
 */
export const localizedText = (t, defaults, key, vars) => {
  const fallback = interpolate(defaults?.[key] ?? key, vars)
  if (typeof t !== 'function') return fallback

  let value
  try {
    value = t(key, { defaultValue: defaults?.[key] ?? key, ...vars })
  } catch {
    return fallback
  }

  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  // i18next returns the key itself when neither a translation nor a usable
  // default is found; that string must never reach the screen.
  if (!trimmed || trimmed === key) return fallback
  return value
}

/**
 * Hook form of {@link localizedText}.
 *
 * @param {Record<string, string>} defaults module-level constant (a fresh
 *   object on every render would defeat the memoisation)
 * @returns {(key: string, vars?: object) => string}
 */
export const useLocalizedText = (defaults) => {
  const { t } = useTranslation()
  return useCallback((key, vars) => localizedText(t, defaults, key, vars), [t, defaults])
}
