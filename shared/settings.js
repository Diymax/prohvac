// Canonical application settings registry.
//
// This module is intentionally runtime-neutral: both browser code and Node
// services import the same key names and translation-routing contract. It does
// not decrypt secrets itself; callers pass a decrypt function so the structural
// and authenticated checks still have one owner without pulling server crypto
// into the browser bundle.

export const SETTING_KEYS = Object.freeze({
  TELEGRAM_BOT_TOKEN: 'telegram.bot_token',
  TELEGRAM_CHAT_ID: 'telegram.chat_id',
  TELEGRAM_TEMPLATE: 'telegram.template',
  TELEGRAM_ENABLED: 'telegram.enabled',
  LEAD_RATE_MAX: 'lead.rate_max',
  LEAD_RATE_WINDOW_MS: 'lead.rate_window_ms',
  FORM_REQUIRE_MESSAGE: 'form.require_message',
  DEEPL_API_KEY: 'translation.deepl.key',
  TRANSLATION_ROUTING: 'translation.routing',
  TRANSLATION_PROTECTED_TERMS: 'translation.protected_terms',
  TRANSLATION_LIMITS: 'translation.limits',
  TRANSLATION_COOLDOWNS: 'translation.cooldowns',
  TRANSLATION_DEEPL_LANGUAGES: 'translation.deepl.languages',
  TRANSLATION_MYMEMORY_EMAIL: 'translation.mymemory.email',
  MEDIA_QUOTA_BYTES: 'media.quota_bytes',
  SEO_TITLE: 'seo.title',
  SEO_DESCRIPTION: 'seo.description',
  SEO_OG_IMAGE: 'seo.og_image',
  METRICA_OAUTH_TOKEN: 'analytics.metrica.oauth_token',
})

export const LEGACY_SETTING_KEYS = Object.freeze({
  DEEPL_API_KEY: 'deepl.api_key',
})

export const SETTING_PREFIXES = Object.freeze({
  TRANSLATION_USAGE: 'translation.usage.',
  TRANSLATION_QUOTA: 'translation.quota.',
})

export const SECRET_PURPOSES = Object.freeze({
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  DEEPL_API_KEY: 'deepl-key',
  METRICA_OAUTH_TOKEN: 'metrica-token',
})

export const TARGET_LOCALES = Object.freeze(['en', 'uz', 'tr', 'ar'])
export const TRANSLATION_PROVIDER_CODES = Object.freeze(['deepl', 'mymemory'])

export const TRANSLATION_PROVIDERS_BY_LANG = Object.freeze(
  Object.fromEntries(
    TARGET_LOCALES.map((lang) => [lang, Object.freeze([...TRANSLATION_PROVIDER_CODES])])
  )
)

const freezeRouting = (routing) =>
  Object.freeze(
    Object.fromEntries(
      TARGET_LOCALES.map((lang) => [lang, Object.freeze([...(routing[lang] ?? [])])])
    )
  )

// Preserve the existing runtime order. An explicitly stored [] is different
// from a missing language: [] disables automatic translation for that language.
export const DEFAULT_TRANSLATION_ROUTING = freezeRouting({
  en: ['deepl'],
  uz: ['deepl', 'mymemory'],
  tr: ['deepl'],
  ar: ['deepl'],
})

export const TELEGRAM_TEMPLATE_PLACEHOLDERS = Object.freeze([
  'name',
  'phone',
  'message',
  'date',
  'lang',
])

export const DEFAULT_TELEGRAM_TEMPLATE = [
  '📩 *Новая заявка \\(сайт PROHVAC\\)*',
  '👤 *Имя:* {name}',
  '📞 *Телефон:* {phone}',
  '💬 *Сообщение:* {message}',
  '🕒 {date} · {lang}',
].join('\n')

const MB = 1024 * 1024

/**
 * Metadata shared by the admin API, providers and UI.
 *
 * `managed` means the key is writable through the admin settings API.
 * `envFallback` names the only deployment fallback allowed for that key.
 * Internal worker state is registered too, but never exposed as an admin field.
 */
export const SETTINGS_REGISTRY = Object.freeze({
  [SETTING_KEYS.TELEGRAM_BOT_TOKEN]: Object.freeze({
    type: 'secret',
    secret: true,
    purpose: SECRET_PURPOSES.TELEGRAM_BOT_TOKEN,
    max: 200,
    default: '',
    managed: true,
    owner: 'telegram',
    envFallback: 'TELEGRAM_BOT_TOKEN',
  }),
  [SETTING_KEYS.TELEGRAM_CHAT_ID]: Object.freeze({
    type: 'string',
    secret: false,
    max: 64,
    default: '',
    managed: true,
    owner: 'telegram',
    envFallback: 'TELEGRAM_CHAT_ID',
  }),
  [SETTING_KEYS.TELEGRAM_TEMPLATE]: Object.freeze({
    type: 'text',
    secret: false,
    max: 2000,
    default: DEFAULT_TELEGRAM_TEMPLATE,
    managed: true,
    owner: 'telegram',
    envFallback: null,
  }),
  [SETTING_KEYS.TELEGRAM_ENABLED]: Object.freeze({
    type: 'bool',
    secret: false,
    default: true,
    managed: true,
    owner: 'telegram',
    envFallback: null,
  }),
  [SETTING_KEYS.LEAD_RATE_MAX]: Object.freeze({
    type: 'int',
    secret: false,
    min: 1,
    max: 1000,
    default: 5,
    managed: true,
    owner: 'lead-intake',
    envFallback: null,
  }),
  [SETTING_KEYS.LEAD_RATE_WINDOW_MS]: Object.freeze({
    type: 'int',
    secret: false,
    min: 1000,
    max: 3_600_000,
    default: 60_000,
    managed: true,
    owner: 'lead-intake',
    envFallback: null,
  }),
  [SETTING_KEYS.FORM_REQUIRE_MESSAGE]: Object.freeze({
    type: 'bool',
    secret: false,
    default: false,
    managed: true,
    owner: 'lead-intake',
    envFallback: null,
  }),
  [SETTING_KEYS.DEEPL_API_KEY]: Object.freeze({
    type: 'secret',
    secret: true,
    purpose: SECRET_PURPOSES.DEEPL_API_KEY,
    max: 200,
    default: '',
    managed: true,
    owner: 'translation',
    envFallback: 'DEEPL_API_KEY',
  }),
  [SETTING_KEYS.TRANSLATION_ROUTING]: Object.freeze({
    type: 'json',
    secret: false,
    default: DEFAULT_TRANSLATION_ROUTING,
    managed: true,
    owner: 'translation',
    envFallback: null,
  }),
  [SETTING_KEYS.TRANSLATION_PROTECTED_TERMS]: Object.freeze({
    type: 'json',
    secret: false,
    default: Object.freeze([]),
    managed: true,
    owner: 'translation',
    envFallback: null,
  }),
  [SETTING_KEYS.TRANSLATION_LIMITS]: Object.freeze({
    type: 'json',
    secret: false,
    default: Object.freeze({}),
    managed: false,
    owner: 'translation',
    envFallback: null,
  }),
  [SETTING_KEYS.TRANSLATION_COOLDOWNS]: Object.freeze({
    type: 'json',
    secret: false,
    default: Object.freeze({}),
    managed: false,
    owner: 'translation',
    envFallback: null,
  }),
  [SETTING_KEYS.TRANSLATION_DEEPL_LANGUAGES]: Object.freeze({
    type: 'json',
    secret: false,
    default: null,
    managed: false,
    owner: 'translation',
    envFallback: null,
  }),
  [SETTING_KEYS.TRANSLATION_MYMEMORY_EMAIL]: Object.freeze({
    type: 'string',
    secret: false,
    max: 254,
    default: '',
    managed: false,
    owner: 'translation',
    envFallback: null,
  }),
  [SETTING_KEYS.MEDIA_QUOTA_BYTES]: Object.freeze({
    type: 'int',
    secret: false,
    min: MB,
    max: 100_000 * MB,
    // The deployment-specific fallback is supplied by server/config.js.
    default: null,
    managed: true,
    owner: 'media',
    envFallback: 'MEDIA_QUOTA_BYTES',
  }),
  [SETTING_KEYS.SEO_TITLE]: Object.freeze({
    type: 'string',
    secret: false,
    max: 120,
    default: '',
    managed: true,
    owner: 'seo',
    envFallback: null,
  }),
  [SETTING_KEYS.SEO_DESCRIPTION]: Object.freeze({
    type: 'string',
    secret: false,
    max: 300,
    default: '',
    managed: true,
    owner: 'seo',
    envFallback: null,
  }),
  [SETTING_KEYS.SEO_OG_IMAGE]: Object.freeze({
    type: 'string',
    secret: false,
    max: 300,
    default: '',
    managed: true,
    owner: 'seo',
    envFallback: null,
  }),
  [SETTING_KEYS.METRICA_OAUTH_TOKEN]: Object.freeze({
    // OAuth-токен Яндекса для чтения статистики через Stat API.
    //
    // Секрет, потому что даёт доступ к отчётам счётчика от имени аккаунта.
    // В реестре, а не только в окружении: токен живёт год, и продлевать его
    // придётся человеку, у которого есть админка, но не обязательно доступ
    // к панели хостинга.
    type: 'secret',
    secret: true,
    purpose: SECRET_PURPOSES.METRICA_OAUTH_TOKEN,
    max: 300,
    default: '',
    managed: true,
    owner: 'analytics',
    envFallback: 'YANDEX_OAUTH_TOKEN',
  }),
})

export const ADMIN_SETTING_KEYS = Object.freeze(
  Object.keys(SETTINGS_REGISTRY).filter((key) => SETTINGS_REGISTRY[key].managed)
)

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const cloneRouting = (routing) =>
  Object.fromEntries(TARGET_LOCALES.map((lang) => [lang, [...(routing[lang] ?? [])]]))

/**
 * Validates and canonicalizes the routing contract. Legacy scalar values are
 * accepted for upgrade safety: "none" becomes [], and "deepl" becomes
 * ["deepl"]. Empty arrays remain empty and never trigger a default fallback.
 */
export const normalizeTranslationRouting = (
  input,
  { defaults = DEFAULT_TRANSLATION_ROUTING, allowLegacyScalars = true } = {}
) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'ожидается объект маршрутизации', value: null }
  }

  const unknownLanguage = Object.keys(input).find((lang) => !TARGET_LOCALES.includes(lang))
  if (unknownLanguage) {
    return { ok: false, reason: `неизвестный язык "${unknownLanguage}"`, value: null }
  }

  const value = {}
  for (const lang of TARGET_LOCALES) {
    let route = own(input, lang) ? input[lang] : defaults[lang] ?? []

    if (allowLegacyScalars && typeof route === 'string') {
      route = route === 'none' ? [] : [route]
    }
    if (!Array.isArray(route)) {
      return { ok: false, reason: `маршрут "${lang}" должен быть массивом`, value: null }
    }

    const allowed = TRANSLATION_PROVIDERS_BY_LANG[lang] ?? []
    const normalized = []
    for (const provider of route) {
      if (typeof provider !== 'string' || !allowed.includes(provider)) {
        return {
          ok: false,
          reason: `провайдер "${String(provider)}" недоступен для языка "${lang}"`,
          value: null,
        }
      }
      if (!normalized.includes(provider)) normalized.push(provider)
    }
    value[lang] = normalized
  }

  return { ok: true, reason: null, value }
}

export const defaultTranslationRouting = () => cloneRouting(DEFAULT_TRANSLATION_ROUTING)

export const SECRET_STATE = Object.freeze({
  ABSENT: 'absent',
  COMPLETE: 'complete',
  CORRUPT: 'corrupt',
})

export const SECRET_CIPHERTEXT_BYTES = Object.freeze({
  iv: 12,
  tag: 16,
})

const byteLength = (value) => {
  if (value == null) return null
  if (value instanceof Uint8Array) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  return null
}

const corruptSecret = (reason, warn) => {
  if (typeof warn === 'function') warn(reason)
  return { state: SECRET_STATE.CORRUPT, reason, value: null }
}

/**
 * Returns absent|complete|corrupt without ever serializing secret material.
 * Passing `decrypt` additionally authenticates ciphertext, so a same-length
 * modified ciphertext is corrupt rather than merely structurally complete.
 */
export const inspectSecretSetting = (row, { decrypt = null, warn = null } = {}) => {
  if (row == null) return { state: SECRET_STATE.ABSENT, reason: null, value: null }
  if (row.is_secret !== 1) return corruptSecret('wrong_storage_type', warn)
  if (row.value !== null && row.value !== undefined) {
    return corruptSecret('plaintext_present', warn)
  }

  const ctBytes = byteLength(row.value_ct)
  const ivBytes = byteLength(row.value_iv)
  const tagBytes = byteLength(row.value_tag)
  if (
    !Number.isInteger(ctBytes) ||
    ctBytes <= 0 ||
    ivBytes !== SECRET_CIPHERTEXT_BYTES.iv ||
    tagBytes !== SECRET_CIPHERTEXT_BYTES.tag
  ) {
    return corruptSecret('ciphertext_incomplete', warn)
  }

  if (typeof decrypt !== 'function') {
    return { state: SECRET_STATE.COMPLETE, reason: null, value: null }
  }

  try {
    const value = decrypt({
      ct: row.value_ct,
      iv: row.value_iv,
      tag: row.value_tag,
    })
    if (typeof value !== 'string' || value.length === 0) {
      return corruptSecret('decrypted_value_invalid', warn)
    }
    return { state: SECRET_STATE.COMPLETE, reason: null, value }
  } catch {
    return corruptSecret('ciphertext_auth_failed', warn)
  }
}
