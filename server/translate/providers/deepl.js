// Провайдер DeepL.
//
// СПИСОК ЯЗЫКОВ НЕ ЗАХАРДКОЖЕН, И ЭТО ПРИНЦИПИАЛЬНО. Открытые источники
// противоречат друг другу насчёт узбекского: одни страницы документации
// и обзоров перечисляют его среди целевых, другие нет, а состав языков
// у DeepL меняется и зависит от тарифа. Единственная истина — ответ API
// с ключом заказчика, поэтому supports() опирается на GET /v2/languages
// (fetchTargetLanguages), а результат кэшируется в settings на сутки:
// список меняется раз в полгода, а запрос к нему стоил бы по обращению
// на каждый тик воркера в каждом процессе пула.
//
// Пока список ни разу не получен, узбекский НЕ заявляется поддерживаемым
// (ASSUMED_TARGETS): в маршрутизации за ним стоит MyMemory, и лучше сразу
// перевести бесплатным фоллбэком, чем отправить текст в DeepL, получить
// bad_request и потратить попытку. Про EN/TR/AR разночтений нет.
//
// БИЛЛИНГ. DeepL считает символы ИСХОДНОГО текста, поэтому billedChars —
// это длина отправленного, а не полученного. Ошибка в другую сторону
// (считать перевод) даёт заниженный счётчик и предполётную проверку,
// которая пропускает пачку за квотой.

import { config } from '../../config.js'
import { SECRET_STATE, SETTINGS_REGISTRY } from '../../../shared/settings.js'
import {
  ProviderError,
  SETTINGS,
  kindForStatus,
  parseRetryAfterMs,
  readJsonSetting,
  readSecretSettingState,
  requestJson,
  writeJsonSetting,
} from '../provider.js'

export const DEEPL_DEFAULT_BASE = 'https://api-free.deepl.com'

const CODE = 'deepl'

// До 50 текстов в одном запросе — ограничение API.
const MAX_BATCH_TEXTS = 50

// Потолок по символам наш, а не DeepL'овский: тело уходит как
// application/x-www-form-urlencoded, где каждый символ кириллицы занимает
// девять байт ('%D0%9F'), и 20 000 символов — это уже около 180 КБ при
// заявленном пределе запроса в 128 КиБ. Берём с запасом.
const MAX_BATCH_CHARS = 12_000

// Сутки. Состав языков у провайдера — величина почти статическая.
const LANGUAGES_TTL_MS = 24 * 60 * 60_000

// Память процесса поверх settings: чтение из SQLite дешёвое, но supports()
// зовётся на каждую задачу очереди.
const MEMORY_TTL_MS = 60_000

// Чем пользуемся, пока настоящий список не получен. См. шапку файла.
const ASSUMED_TARGETS = Object.freeze(['en', 'tr', 'ar'])

// Запасное соответствие на тот же случай. 'EN-US' вместо 'EN': голый 'EN'
// в целевых языках объявлен устаревшим и отвечает предупреждением.
const FALLBACK_CODES = Object.freeze({ en: 'EN-US', uz: 'UZ', tr: 'TR', ar: 'AR' })

/**
 * Наш двухбуквенный код -> код DeepL из полученного списка.
 * Точное совпадение важнее вариантного ('TR'), затем берётся первый вариант
 * с нужным префиксом ('EN' -> 'EN-GB'/'EN-US'), причём EN-US предпочитается:
 * лендинг ориентирован на международную аудиторию, а не на Британию.
 */
const matchTarget = (lang, targets) => {
  const upper = lang.toUpperCase()
  if (targets.includes(upper)) return upper

  const variants = targets.filter((code) => code.startsWith(`${upper}-`))
  if (!variants.length) return null
  return variants.includes(`${upper}-US`) ? `${upper}-US` : variants[0]
}

/**
 * @param {{db: object, apiKey?: string, envApiKey?: string, base?: string}} deps
 *   apiKey и base передаются в тестах; в рантайме ключ читается из settings,
 *   а envApiKey (по умолчанию DEEPL_API_KEY) используется только пока записи
 *   в базе нет.
 */
export const createDeepLProvider = (deps = {}) => {
  const { db } = deps
  if (!db && !deps.apiKey) throw new TypeError('deepl: нужен deps.db')

  // Кэш списка языков в памяти процесса: {targets, fetchedAt, readAt}.
  let cached = null

  const apiKey = () => {
    if (Object.prototype.hasOwnProperty.call(deps, 'apiKey')) return deps.apiKey || ''

    const stored = readSecretSettingState(
      db,
      SETTINGS.deeplKey,
      SETTINGS_REGISTRY[SETTINGS.deeplKey].purpose
    )
    if (stored.state === SECRET_STATE.COMPLETE) return stored.value
    // A corrupt row is an explicit but unusable override. Falling back to an
    // older deployment key would silently switch account/billing ownership.
    if (stored.state === SECRET_STATE.CORRUPT) return ''
    const environmentKey = Object.prototype.hasOwnProperty.call(deps, 'envApiKey')
      ? deps.envApiKey
      : config.deeplApiKey
    return environmentKey || ''
  }

  const base = () => {
    const value = (deps.base || '').trim() || DEEPL_DEFAULT_BASE
    // Хвостовой слэш в панели ставят через раз, а '//v2/translate' у DeepL
    // отвечает 404 — то есть «ключ не работает» на ровном месте.
    return value.replace(/\/+$/, '')
  }

  const authHeaders = () => ({ Authorization: `DeepL-Auth-Key ${apiKey()}` })

  /** Кэш из settings, не чаще раза в MEMORY_TTL_MS. */
  const readCache = (now) => {
    if (cached && now - cached.readAt < MEMORY_TTL_MS) return cached

    const stored = readJsonSetting(db, SETTINGS.deeplLanguages, null)
    const targets = Array.isArray(stored?.targets)
      ? stored.targets.filter((code) => typeof code === 'string')
      : null
    cached = {
      targets,
      fetchedAt: Number(stored?.fetchedAt) || 0,
      readAt: now,
    }
    return cached
  }

  /**
   * Ошибка запроса к DeepL в общем виде. Коды, о которых сказано явно:
   * 429 — просят притормозить, 456 — кончилась квота тарифа,
   * 403 — ключ не принят.
   */
  const failure = (status, text, headers, now) => {
    const kind = kindForStatus(status)
    const retryAfterMs = parseRetryAfterMs(headers?.get?.('retry-after'), now)
    // Тело ошибки DeepL короткое ({"message":"..."}), но резать всё равно надо:
    // это значение уезжает в translation_jobs.last_error и в интерфейс.
    const detail = String(text || '').slice(0, 300)
    return new ProviderError(kind, `deepl: HTTP ${status} ${detail}`, {
      provider: CODE,
      status,
      retryAfterMs,
    })
  }

  /**
   * Список целевых языков от самого API. Кэшируется в settings на сутки —
   * это общий кэш на весь пул процессов, поэтому обновление делает первый,
   * кто до него дошёл, а не каждый.
   *
   * @param {{force?: boolean, now?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<string[]|null>} null, если получить список не удалось
   */
  const fetchTargetLanguages = async (options = {}) => {
    const { force = false, now = Date.now(), signal = null } = options

    const current = readCache(now)
    if (!force && current.targets && now - current.fetchedAt < LANGUAGES_TTL_MS) {
      return current.targets
    }
    if (!apiKey()) return current.targets

    const { status, data, text, headers } = await requestJson(
      `${base()}/v2/languages?type=target`,
      { headers: authHeaders(), signal, provider: CODE }
    )

    if (status < 200 || status >= 300) throw failure(status, text, headers, now)
    if (!Array.isArray(data)) {
      throw new ProviderError('transient', 'deepl: список языков пришёл не массивом', {
        provider: CODE,
        status,
      })
    }

    const targets = data
      .map((item) => (typeof item?.language === 'string' ? item.language.toUpperCase() : ''))
      .filter(Boolean)

    writeJsonSetting(db, SETTINGS.deeplLanguages, { targets, fetchedAt: now }, now)
    cached = { targets, fetchedAt: now, readAt: now }
    return targets
  }

  /**
   * Прогрев перед выбором провайдера. Сбой глушится: не получив список,
   * работаем по ASSUMED_TARGETS, а не отказываемся переводить вообще.
   */
  const prepare = async (options = {}) => {
    try {
      await fetchTargetLanguages(options)
    } catch (error) {
      console.error(`[deepl] список целевых языков недоступен: ${error.message}`)
    }
  }

  const supports = (lang, now = Date.now()) => {
    if (typeof lang !== 'string') return false
    const { targets } = readCache(now)
    if (!targets) return ASSUMED_TARGETS.includes(lang)
    return matchTarget(lang, targets) !== null
  }

  const toProviderLang = (lang, now = Date.now()) => {
    const { targets } = readCache(now)
    const matched = targets ? matchTarget(lang, targets) : null
    return matched ?? FALLBACK_CODES[lang] ?? String(lang).toUpperCase()
  }

  /**
   * Перевод пачки. Порядок ответа DeepL совпадает с порядком запроса —
   * на этом держится сопоставление с задачами очереди, поэтому расхождение
   * длин трактуется как ошибка запроса, а не как «переведём что дали».
   */
  const translate = async (texts, targetLang, options = {}) => {
    const { signal = null, now = Date.now() } = options

    if (!Array.isArray(texts) || !texts.length) return { texts: [], billedChars: 0 }
    if (!apiKey()) {
      throw new ProviderError('auth', 'deepl: ключ API не задан', { provider: CODE })
    }
    if (texts.length > MAX_BATCH_TEXTS) {
      throw new ProviderError('bad_request', `deepl: в пачке ${texts.length} текстов при пределе ${MAX_BATCH_TEXTS}`, {
        provider: CODE,
      })
    }

    const params = new URLSearchParams()
    params.set('source_lang', 'RU')
    params.set('target_lang', targetLang)
    // Иначе DeepL «причёсывает» пунктуацию и переносы: в интерфейсных строках
    // это ломает вёрстку (двойные пробелы, съеденные переводы строк).
    params.set('preserve_formatting', '1')
    for (const text of texts) params.append('text', text)

    const { status, data, text, headers } = await requestJson(`${base()}/v2/translate`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: params.toString(),
      signal,
      provider: CODE,
    })

    if (status < 200 || status >= 300) {
      // 400 на конкретной паре языков — это чаще всего «язык не поддержан»,
      // а не битый запрос: реестру важно различать, чтобы отдать задачу
      // следующему провайдеру, а не гонять её по кругу до исчерпания попыток.
      if (status === 400 && /target_lang|language/i.test(String(text || ''))) {
        throw new ProviderError('unsupported_lang', `deepl: язык ${targetLang} не принят (HTTP 400)`, {
          provider: CODE,
          status,
        })
      }
      throw failure(status, text, headers, now)
    }

    const translations = Array.isArray(data?.translations) ? data.translations : null
    if (!translations || translations.length !== texts.length) {
      throw new ProviderError('bad_request', `deepl: пришло ${translations?.length ?? 0} переводов на ${texts.length} текстов`, {
        provider: CODE,
        status,
      })
    }

    return {
      texts: translations.map((item) => (typeof item?.text === 'string' ? item.text : '')),
      billedChars: texts.reduce((sum, item) => sum + item.length, 0),
    }
  }

  /**
   * Остаток по тарифу от самого DeepL. Это единственный честный источник:
   * локальный счётчик не знает про переводы, сделанные вне этого сайта тем же
   * ключом. Кэширование и падение на локальный счётчик — в usage.js.
   *
   * @returns {Promise<{used: number, limit: number|null}|null>}
   */
  const usage = async (options = {}) => {
    const { signal = null, now = Date.now() } = options
    if (!apiKey()) return null

    const { status, data, text, headers } = await requestJson(`${base()}/v2/usage`, {
      headers: authHeaders(),
      signal,
      provider: CODE,
    })

    if (status < 200 || status >= 300) throw failure(status, text, headers, now)

    const used = Number(data?.character_count)
    const limit = Number(data?.character_limit)
    if (!Number.isFinite(used)) return null

    return { used, limit: Number.isFinite(limit) && limit > 0 ? limit : null }
  }

  return {
    code: CODE,
    title: 'DeepL',
    maxBatchTexts: MAX_BATCH_TEXTS,
    maxBatchChars: MAX_BATCH_CHARS,
    configFields: Object.freeze([
      { name: SETTINGS.deeplKey, label: 'Ключ API DeepL', type: 'secret' },
    ]),
    isConfigured: () => Boolean(apiKey()),
    supports,
    toProviderLang,
    prepare,
    fetchTargetLanguages,
    translate,
    usage,
  }
}
