// Application settings: schema, validation, typed reads and the write path.
//
// WHY THIS IS NOT ENVIRONMENT VARIABLES. The bot token, the chat id, the
// message template and the form limits are edited live: swapping the bot must
// not require access to the hosting panel and a pool restart. Environment
// variables stay as the deployment default (config.*), a row in `settings`
// overrides it.
//
// THE SECRET NEVER LEAVES. `list()` exposes only the mask ('dpl_****4f2a') and
// an isSet flag for secret keys; the decrypted value goes into no response, no
// audit record and no error text. The listing is fetched on every visit to the
// settings screen, so it ends up in the browser cache, in screenshots and in
// whoever is standing behind the operator. Server code that is about to *use* a
// secret reads it through `read()`, and nothing else does.
//
// CACHING. Plain values are cached per settings revision (see
// repositories/settings.js): the revision is one cheap aggregate read, and it
// changes on any write from any process of the Passenger pool, so a cached
// bundle can never outlive the write that invalidates it. Secrets are excluded
// from the cache on purpose - see the repository header.

import {
  ADMIN_SETTING_KEYS,
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  SECRET_STATE,
  normalizeTranslationRouting,
} from '../../shared/settings.js'
import { getSettingsRepository } from '../repositories/settings.js'
import {
  TEMPLATE_PLACEHOLDERS,
  renderTemplate,
  unknownPlaceholders,
} from '../domain/lead-message.js'
import { findMarkdownV2Error } from '../../shared/telegram-markdown.js'
import { config } from '../config.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// A @BotFather token: '<bot id>:<35 chars>'. The check is strict because the
// most common mistake here is pasting the wrong thing into the field (the chat
// id, a DeepL key, a token with a truncated tail); without it that would only
// surface with the first lost lead instead of at save time.
const BOT_TOKEN_PATTERN = /^\d{5,16}:[A-Za-z0-9_-]{30,45}$/

// A numeric id (negative for groups and supergroups) or an @channel name.
const CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/

// The og:image picture: either a file we host or an absolute https URL.
// OAuth-токен Яндекса. Проверка нарочно грубая — формат токена Яндексом
// не зафиксирован и менялся (сейчас это строка вида 'y0_Ag...'). Смысл
// шаблона тот же, что у токена бота: поймать не тот текст, вставленный
// в поле (номер счётчика, логин, ссылку на кабинет), а не валидировать
// сам токен. Настоящая проверка — первый ответ Stat API.
const METRICA_TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,300}$/

const OG_IMAGE_PATTERN = /^(\/media\/[A-Za-z0-9._-]{1,120}|https:\/\/[^\s"'<>]{1,280})$/

const validateRouting = (value) => {
  const normalized = normalizeTranslationRouting(value, { allowLegacyScalars: false })
  return normalized.ok ? null : normalized.reason
}

const coerceRouting = (value) => {
  const normalized = normalizeTranslationRouting(value)
  return normalized.ok ? normalized.value : value
}

const TERM_MAX = 64
const TERMS_MAX = 200

/**
 * Terms that must not be translated (names, equipment brands). Both an array
 * and one-term-per-line text are accepted: the UI field is a textarea and the
 * API takes JSON, and demanding a hand-built array would mostly produce an
 * array of one string containing every term.
 */
const coerceTerms = (value) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]/)

  return list
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

const validateTerms = (value) => {
  if (!Array.isArray(value)) return 'ожидается массив строк'
  if (value.length > TERMS_MAX) return `не больше ${TERMS_MAX} терминов`
  for (const term of value) {
    if (typeof term !== 'string' || !term) return 'термин не может быть пустым'
    if (term.length > TERM_MAX) return `термин длиннее ${TERM_MAX} символов`
  }
  return null
}

/**
 * Everything that may be written into `settings`.
 *
 * The schema is a trust boundary, not decoration: the key arrives in a request
 * body, and without an allow-list the admin API would be an arbitrary write
 * into the table. Application code around it (the lead limiter, the translator,
 * media) reads these keys through `read()` and relies on the value already
 * having the declared type.
 *
 * type:
 *   secret — encrypted, only a mask leaves the server;
 *   string — a single line without control characters;
 *   text   — multi-line text (the message template);
 *   bool   — stored as '1'/'0';
 *   int    — stored as a decimal string;
 *   json   — stored as JSON.
 */
export const SETTINGS_SCHEMA = Object.freeze({
  [SETTING_KEYS.TELEGRAM_BOT_TOKEN]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.TELEGRAM_BOT_TOKEN],
    pattern: BOT_TOKEN_PATTERN,
    hint: 'токен от @BotFather вида 123456789:AA...',
  },
  [SETTING_KEYS.TELEGRAM_CHAT_ID]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.TELEGRAM_CHAT_ID],
    pattern: CHAT_ID_PATTERN,
    hint: 'числовой id чата или @имя канала',
  },
  [SETTING_KEYS.TELEGRAM_TEMPLATE]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.TELEGRAM_TEMPLATE],
    hint: `MarkdownV2; плейсхолдеры: ${TEMPLATE_PLACEHOLDERS.map((n) => `{${n}}`).join(' ')}`,
  },
  [SETTING_KEYS.TELEGRAM_ENABLED]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.TELEGRAM_ENABLED],
  },
  [SETTING_KEYS.LEAD_RATE_MAX]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.LEAD_RATE_MAX],
  },
  [SETTING_KEYS.LEAD_RATE_WINDOW_MS]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.LEAD_RATE_WINDOW_MS],
  },
  [SETTING_KEYS.FORM_REQUIRE_MESSAGE]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.FORM_REQUIRE_MESSAGE],
  },
  [SETTING_KEYS.DEEPL_API_KEY]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.DEEPL_API_KEY],
    hint: 'ключ DeepL вида xxxxxxxx-....:fx',
  },
  [SETTING_KEYS.TRANSLATION_ROUTING]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.TRANSLATION_ROUTING],
    coerce: coerceRouting,
    validate: validateRouting,
    hint: 'упорядоченная цепочка провайдеров; пустой список отключает автоперевод',
  },
  [SETTING_KEYS.TRANSLATION_PROTECTED_TERMS]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.TRANSLATION_PROTECTED_TERMS],
    coerce: coerceTerms,
    validate: validateTerms,
    hint: 'термины, которые остаются без перевода',
  },
  // The default comes from the environment: disk quota is a property of the
  // hosting plan, and the panel sets it before anyone opens the admin UI.
  [SETTING_KEYS.MEDIA_QUOTA_BYTES]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.MEDIA_QUOTA_BYTES],
    default: config.mediaQuotaBytes,
  },
  [SETTING_KEYS.SEO_TITLE]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.SEO_TITLE],
  },
  [SETTING_KEYS.SEO_DESCRIPTION]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.SEO_DESCRIPTION],
  },
  [SETTING_KEYS.SEO_OG_IMAGE]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.SEO_OG_IMAGE],
    pattern: OG_IMAGE_PATTERN,
  },
  [SETTING_KEYS.METRICA_OAUTH_TOKEN]: {
    ...SETTINGS_REGISTRY[SETTING_KEYS.METRICA_OAUTH_TOKEN],
    pattern: METRICA_TOKEN_PATTERN,
    hint: 'OAuth-токен Яндекса со scope metrika:read',
  },
})

export const SETTINGS_KEYS = ADMIN_SETTING_KEYS

// Keys that appear in the public content response and therefore have to
// advance the content generation when they change.
const PUBLIC_CONTENT_SETTINGS = new Set([
  SETTING_KEYS.FORM_REQUIRE_MESSAGE,
  SETTING_KEYS.SEO_TITLE,
  SETTING_KEYS.SEO_DESCRIPTION,
  SETTING_KEYS.SEO_OG_IMAGE,
])

const PLAIN_KEYS = Object.freeze(
  Object.keys(SETTINGS_SCHEMA).filter((key) => SETTINGS_SCHEMA[key].type !== 'secret')
)

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

// Control characters break the UI layout, headers and logs alike. Single-line
// values forbid all of them, multi-line values allow newline and tab.
// eslint-disable-next-line no-control-regex
const CONTROL_ANY = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

const invalid = (reason) => ({ ok: false, reason })

const validateText = (entry, raw, controlPattern) => {
  if (typeof raw !== 'string') return invalid('ожидается строка')
  // \r\n from a textarea is normalized to \n: otherwise the same value typed
  // on Windows and on Linux produces different rows and a different template.
  const value = raw.replace(/\r\n?/g, '\n').trim()
  if (value.length > entry.max) return invalid(`длиннее ${entry.max} символов`)
  if (controlPattern.test(value)) return invalid('содержит управляющие символы')
  if (entry.pattern && value && !entry.pattern.test(value)) return invalid('не подходит по формату')
  return { ok: true, value }
}

/**
 * Canonicalizes and checks a submitted value. Returns { ok: true, value } or
 * { ok: false, reason }, where the reason is human-readable and travels to the
 * client next to error: 'invalid_value'.
 */
// Значения для проверки разметки шаблона. Намеренно без служебных символов:
// проверяется шаблон, а не экранирование подставляемых значений — за него
// отвечает renderTemplate() и покрывают тесты shared/lead.test.js.
const TEMPLATE_SAMPLE = Object.freeze({
  name: 'Имя',
  phone: '998900000000',
  message: 'текст',
  date: '2026-01-01 00:00',
  lang: 'ru',
})

export const validateSettingValue = (key, raw) => {
  const entry = SETTINGS_SCHEMA[key]
  if (!entry) return invalid('неизвестный ключ')

  switch (entry.type) {
    case 'secret': {
      if (typeof raw !== 'string') return invalid('ожидается строка')
      const value = raw.trim()
      // An empty string is the command "remove the secret": seal() does not
      // encrypt emptiness (see secretbox.js), and an unset secret is stored as
      // the absence of a row.
      if (!value) return { ok: true, value: '', unset: true }
      if (value.length > entry.max) return invalid(`длиннее ${entry.max} символов`)
      if (CONTROL_ANY.test(value)) return invalid('содержит управляющие символы')
      if (entry.pattern && !entry.pattern.test(value)) {
        return invalid(entry.hint ? `не похоже на ${entry.hint}` : 'не подходит по формату')
      }
      return { ok: true, value }
    }

    case 'string':
      return validateText(entry, raw, CONTROL_ANY)

    case 'text': {
      const checked = validateText(entry, raw, CONTROL_EXCEPT_NEWLINE)
      if (!checked.ok) return checked
      // A typo in a placeholder name ('{tel}') is indistinguishable from prose
      // and would only be discovered in the chat. Catch it here.
      const unknown = unknownPlaceholders(checked.value)
      if (unknown.length) return invalid(`неизвестный плейсхолдер {${unknown[0]}}`)

      if (key === SETTING_KEYS.TELEGRAM_TEMPLATE) {
        // Проверяется ОТРЕНДЕРЕННЫЙ текст, а не сам шаблон: '{' и '}' —
        // служебные символы MarkdownV2, и на исходнике проверка ругалась бы
        // на каждый плейсхолдер. Подставляются заведомо безопасные значения,
        // потому что настоящие всё равно экранируются при подстановке, и
        // отвечать за разметку может только сам шаблон.
        const error = findMarkdownV2Error(renderTemplate(checked.value, TEMPLATE_SAMPLE))
        if (error) {
          // Шаблон с поломанной разметкой Telegram отвергает целиком: раньше
          // это выяснялось первой потерянной заявкой, а не при сохранении.
          return invalid(`разметка MarkdownV2: ${error.reason}`)
        }
      }

      return checked
    }

    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      const text = String(raw ?? '').trim().toLowerCase()
      if (TRUE_VALUES.has(text)) return { ok: true, value: true }
      if (FALSE_VALUES.has(text)) return { ok: true, value: false }
      return invalid('ожидается true или false')
    }

    case 'int': {
      // Number, not parseInt: parseInt('10abc') would return 10 and silently
      // swallow the garbage - the same trap as in server/config.js.
      const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
      if (!Number.isSafeInteger(value)) return invalid('ожидается целое число')
      if (value < entry.min || value > entry.max) {
        return invalid(`допустимо от ${entry.min} до ${entry.max}`)
      }
      return { ok: true, value }
    }

    case 'json': {
      let parsed = raw
      if (typeof raw === 'string') {
        const text = raw.trim()
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {
          // Not JSON - but for the protected-terms list that is normal textarea
          // input, and rejecting it would mean demanding quotes from a human.
          parsed = entry.coerce ? text : undefined
          if (parsed === undefined) return invalid('ожидается корректный JSON')
        }
      }
      if (entry.coerce) parsed = entry.coerce(parsed)

      const reason = entry.validate ? entry.validate(parsed) : null
      if (reason) return invalid(reason)
      return { ok: true, value: parsed }
    }

    default:
      // Unreachable while the schema and this switch agree. A silent "success"
      // here would mean writing an unvalidated value.
      return invalid('тип значения не поддерживается')
  }
}

/** Canonical value -> the string stored in settings.value. */
export const encodeValue = (entry, value) => {
  switch (entry.type) {
    case 'bool':
      return value ? '1' : '0'
    case 'int':
      return String(value)
    case 'json':
      return JSON.stringify(value)
    default:
      return String(value)
  }
}

/** Stored string -> the value type application code expects. */
const decodeValue = (entry, stored) => {
  switch (entry.type) {
    case 'bool':
      return stored === '1'
    case 'int': {
      const value = Number(stored)
      return Number.isSafeInteger(value) ? value : entry.default
    }
    case 'json':
      try {
        return JSON.parse(stored)
      } catch {
        // Broken JSON in the table means a manual edit or a failed write.
        // Working on the default beats failing on every settings read.
        console.error(`[settings] значение не разбирается как JSON, взято умолчание`)
        return entry.default
      }
    default:
      return stored
  }
}

// Values used while the table cannot be read at all. Not cached: the very next
// call must try the database again.
const DEFAULT_SNAPSHOT = Object.freeze({
  revision: null,
  values: Object.freeze(
    Object.fromEntries(PLAIN_KEYS.map((key) => [key, SETTINGS_SCHEMA[key].default]))
  ),
})

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Typed settings access for one connection.
 *
 * @param {object} db connection from server/db/index.js
 */
export const createSettingsService = (db) => {
  const repository = getSettingsRepository(db)

  // The last snapshot, keyed by the revision it was built from.
  let cached = null

  const buildValues = (rows) => {
    const byKey = new Map()
    for (const row of rows) byKey.set(row.key, row)

    const values = {}
    for (const key of PLAIN_KEYS) {
      const entry = SETTINGS_SCHEMA[key]
      const row = byKey.get(key)
      values[key] = row?.value == null ? entry.default : decodeValue(entry, row.value)
    }
    return Object.freeze(values)
  }

  /**
   * Immutable view of every non-secret setting.
   *
   * Callers that need more than one value take the snapshot once and read from
   * it: a settings change made while a request is running then cannot produce a
   * configuration assembled half from before and half from after the change.
   */
  const snapshot = () => {
    let revision
    try {
      revision = repository.revision()
    } catch (error) {
      console.error(`[settings] ревизия настроек не прочитана: ${error.message}`)
      return cached ?? DEFAULT_SNAPSHOT
    }

    if (cached && cached.revision === revision) return cached

    let rows
    try {
      rows = repository.listRows()
    } catch (error) {
      console.error(`[settings] чтение настроек не удалось: ${error.message}`)
      return cached ?? DEFAULT_SNAPSHOT
    }

    cached = Object.freeze({ revision, values: buildValues(rows) })
    return cached
  }

  const entryFor = (key) => {
    const entry = SETTINGS_SCHEMA[key]
    if (!entry) throw new TypeError(`settings: неизвестный ключ "${key}"`)
    return entry
  }

  /** Inspected secret record; the plaintext is present only for COMPLETE. */
  const readSecretState = (key) => repository.readSecret(key, entryFor(key).purpose)

  /**
   * Value of a setting: from the table, or the schema default when absent.
   *
   * FOR SECRETS THIS RETURNS PLAINTEXT. Call it only where the secret goes
   * straight into an outbound request (a DeepL header, a Bot API URL), and
   * never put the result into a response, a log or an audit record.
   */
  const read = (key) => {
    const entry = entryFor(key)
    if (entry.type === 'secret') {
      const inspected = readSecretState(key)
      return inspected.state === SECRET_STATE.COMPLETE ? inspected.value : ''
    }
    return snapshot().values[key]
  }

  /**
   * The admin listing. Every schema key is returned, including the unset ones:
   * the UI draws its form from this response, and a key missing from the table
   * has to appear with its default rather than disappear.
   *
   * Secret keys carry only the mask and an isSet flag - never the value, never
   * the ciphertext. The mask is shown only after the ciphertext authenticates,
   * so a damaged record cannot look like a working key.
   */
  const list = () => {
    const rows = new Map()
    for (const row of repository.listRows()) rows.set(row.key, row)

    return SETTINGS_KEYS.map((key) => {
      const entry = SETTINGS_SCHEMA[key]
      const row = rows.get(key)

      if (entry.type === 'secret') {
        const inspected = repository.inspectRow(key, entry.purpose, row)
        const isSet = inspected.state === SECRET_STATE.COMPLETE
        return {
          key,
          type: 'secret',
          isSecret: true,
          isSet,
          preview: isSet ? row?.preview ?? '' : '',
          hint: entry.hint ?? null,
          updatedAt: row?.updated_at ?? null,
        }
      }

      return {
        key,
        type: entry.type,
        isSecret: false,
        isSet: row?.value != null,
        value: row?.value == null ? entry.default : decodeValue(entry, row.value),
        default: entry.default,
        hint: entry.hint ?? null,
        updatedAt: row?.updated_at ?? null,
      }
    })
  }

  /**
   * Applies an already validated value.
   *
   * `onWrite` runs inside the same transaction as the write itself, which is
   * how the caller records an audit entry that cannot survive a rolled-back
   * change. It receives { key, isSecret, wasSet, isSet, encoded } - never the
   * secret value.
   *
   * @returns {{key: string, isSecret: boolean, isSet: boolean, preview: string|null,
   *            value: *, wasSet: boolean}}
   */
  const write = (key, checked, { userId = null, now = Date.now(), onWrite = null } = {}) => {
    const entry = entryFor(key)
    const isSecret = entry.type === 'secret'
    const before = repository.readRow(key)
    const wasSet = isSecret
      ? repository.inspectRow(key, entry.purpose, before).state === SECRET_STATE.COMPLETE
      : before?.value != null

    if (isSecret && checked.unset) {
      const result = { key, isSecret: true, isSet: false, preview: '', value: '', wasSet }
      db.transaction(() => {
        repository.remove(key)
        if (onWrite) onWrite({ key, isSecret: true, wasSet, isSet: false, encoded: null })
      })
      return result
    }

    if (isSecret) {
      let preview = ''
      db.transaction(() => {
        preview = repository.writeSecret(key, checked.value, entry.purpose, {
          now,
          updatedBy: userId,
        })
        if (onWrite) onWrite({ key, isSecret: true, wasSet, isSet: true, encoded: null })
      })
      return { key, isSecret: true, isSet: true, preview, value: '', wasSet }
    }

    const encoded = encodeValue(entry, checked.value)
    db.transaction(() => {
      repository.writePlain(key, encoded, { now, updatedBy: userId })
      if (PUBLIC_CONTENT_SETTINGS.has(key)) repository.bumpContentGeneration(now)
      if (onWrite) onWrite({ key, isSecret: false, wasSet, isSet: true, encoded })
    })
    return { key, isSecret: false, isSet: true, preview: null, value: checked.value, wasSet }
  }

  return {
    schema: SETTINGS_SCHEMA,
    keys: SETTINGS_KEYS,
    snapshot,
    read,
    readSecretState,
    list,
    validate: validateSettingValue,
    write,
  }
}

// One service per connection so that the revision cache is shared by every
// consumer of the same database.
const services = new WeakMap()

/** Shared settings service for a connection. */
export const getSettingsService = (db) => {
  let service = services.get(db)
  if (!service) {
    service = createSettingsService(db)
    services.set(db, service)
  }
  return service
}

/**
 * Value of a single setting. Convenience wrapper over the shared service for
 * call sites that read one key and hold only a connection.
 *
 * FOR SECRETS THIS RETURNS PLAINTEXT - see `read()` above.
 */
export const readSetting = (db, key) => getSettingsService(db).read(key)

/** Immutable snapshot of every non-secret setting. */
export const settingsSnapshot = (db) => getSettingsService(db).snapshot()
