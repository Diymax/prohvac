// Контракт провайдера перевода и общая инфраструктура под все реализации.
//
// ЗАЧЕМ АБСТРАКЦИЯ. Воркер (worker.js) не должен знать ни одного адреса
// и ни одного кода ошибки конкретного сервиса: он берёт объект-провайдер,
// спрашивает у него размеры пачки и зовёт translate(). Всё, что различается
// между DeepL и MyMemory — формат запроса, коды состояния, названия языков, —
// живёт внутри providers/*.js. Иначе смена провайдера означала бы правку
// очереди, а очередь — самое дорогое место в этом конвейере: в ней квота,
// идемпотентность и аренда между процессами.
//
// Контракт провайдера:
//   {
//     code, title,                       // 'deepl', 'DeepL'
//     supports(lang) -> boolean,         // синхронно, по кэшу
//     toProviderLang(lang) -> string,    // 'en' -> 'EN-US'
//     isConfigured() -> boolean,         // есть ли ключ и адрес
//     maxBatchTexts, maxBatchChars,      // границы одной пачки
//     translate(texts, targetLang, {signal}) -> {texts: [], billedChars},
//     usage() -> Promise<{used, limit}|null>,
//     prepare?() -> Promise<void>,       // прогрев кэшей (список языков)
//     configFields: [{name, label, type}]
//   }
//
// isConfigured() и prepare() в исходной постановке не значились, но без них
// реестр не может ответить на вопрос «можно ли сейчас отправить сюда текст»,
// не выполнив сам сетевой запрос: ключ лежит в settings и меняется из админки,
// а список языков DeepL подтягивается асинхронно.
//
// ОШИБКИ. Наружу летит только ProviderError с полем kind — воркер принимает
// решение о повторе и о бэкоффе по нему, и добавление третьего провайдера
// не должно требовать нового ветвления в очереди.

import { readSecretRecord } from '../repositories/settings.js'
import {
  SECRET_STATE,
  SETTING_KEYS,
  SETTING_PREFIXES,
} from '../../shared/settings.js'

// Исходный язык один: тексты пишутся по-русски, всё остальное — производное.
export const SOURCE_LANG = 'ru'

// Целевые языки. Тот же набор, что в CHECK content_entries.locale, минус ru.
export const TARGET_LANGS = Object.freeze(['en', 'uz', 'tr', 'ar'])

export const isTargetLang = (lang) => TARGET_LANGS.includes(lang)

/**
 * Ключи settings, которыми пользуется конвейер. Строками по месту их писать
 * нельзя: опечатка в ключе не падает, а тихо возвращает значение по умолчанию,
 * и «настройка не применяется» выясняется на боевом счёте за перевод.
 */
export const SETTINGS = Object.freeze({
  routing: SETTING_KEYS.TRANSLATION_ROUTING,
  protectedTerms: SETTING_KEYS.TRANSLATION_PROTECTED_TERMS,
  monthlyLimits: SETTING_KEYS.TRANSLATION_LIMITS,
  cooldowns: SETTING_KEYS.TRANSLATION_COOLDOWNS,
  usagePrefix: SETTING_PREFIXES.TRANSLATION_USAGE,
  quotaPrefix: SETTING_PREFIXES.TRANSLATION_QUOTA,
  deeplKey: SETTING_KEYS.DEEPL_API_KEY,
  deeplLanguages: SETTING_KEYS.TRANSLATION_DEEPL_LANGUAGES,
  mymemoryEmail: SETTING_KEYS.TRANSLATION_MYMEMORY_EMAIL,
})

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

// rate_limit       — попросили подождать, ничего не сломано;
// quota            — лимит тарифа исчерпан, ждать до следующего периода;
// auth             — ключ неверный или отозван, повтор бесполезен;
// unsupported_lang — провайдер не умеет этот язык, нужен другой провайдер;
// bad_request      — виноват наш запрос (слишком длинный текст, кривой код);
// transient        — сеть, таймаут, 5xx: повторить позже.
export const ERROR_KINDS = Object.freeze([
  'rate_limit',
  'quota',
  'auth',
  'unsupported_lang',
  'bad_request',
  'transient',
])

const KIND_SET = new Set(ERROR_KINDS)

/**
 * Нормализованная ошибка провайдера.
 *
 * kind неизвестного значения превращается в 'transient', а не бросает:
 * ошибка в обработчике ошибок — это потерянная задача очереди, и худшее,
 * что может случиться от неверного kind, — лишний повтор через минуту.
 */
export class ProviderError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.kind = KIND_SET.has(kind) ? kind : 'transient'
    this.provider = options.provider ?? null
    this.status = options.status ?? null
    // Сколько просят подождать. null означает «решай сам по бэкоффу».
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

/**
 * Код состояния HTTP -> kind. Значения, специфичные для конкретного сервиса
 * (456 у DeepL — исчерпанная квота), провайдер уточняет сам; здесь общий случай.
 */
export const kindForStatus = (status) => {
  if (status === 429) return 'rate_limit'
  if (status === 456) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 409 || status >= 500) return 'transient'
  if (status >= 400) return 'bad_request'
  return 'transient'
}

/**
 * Retry-After в миллисекундах. Заголовок бывает в двух формах — число секунд
 * и HTTP-дата, — и обе встречаются у реальных сервисов.
 *
 * @returns {number|null} null, если заголовка нет или он не разобран
 */
export const parseRetryAfterMs = (value, now = Date.now()) => {
  if (typeof value !== 'string' || !value.trim()) return null

  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 86_400) * 1000

  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  // Дата в прошлом означает «уже можно»: отрицательная пауза сломала бы
  // run_after задачи (она уехала бы в прошлое вместе с бэкоффом).
  return Math.max(0, Math.min(date - now, 86_400_000))
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Провайдер отвечает за секунды. 20 с — это уже «сервис лежит», и держать
// аренду очереди дольше незачем: она живёт две минуты, а батчей в тике много.
const DEFAULT_TIMEOUT_MS = 20_000

// Потолок ответа. Переводы — это килобайты; мегабайты означают, что мы попали
// не туда (страница-заглушка провайдера, перехват прокси), и разбирать такое
// как JSON бессмысленно.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * Объединяет сигнал вызывающего с таймаутом. AbortSignal.any есть с Node 20;
 * на более старых сборках остаётся только таймаут — отмена снаружи в этом
 * конвейере не критична, а падать из-за отсутствия метода нельзя.
 */
const withTimeout = (signal, timeoutMs) => {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof AbortSignal.any !== 'function') return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Запрос к API провайдера. Возвращает разобранный ответ БЕЗ проверки статуса:
 * что значит 456 или 403, знает только сам провайдер.
 *
 * Любой сбой транспорта нормализуется в ProviderError('transient'): DNS, обрыв,
 * таймаут и отмена одинаково лечатся повтором, и различать их в очереди нечем.
 *
 * @returns {Promise<{status: number, headers: Headers, text: string, data: any}>}
 */
export const requestJson = async (url, options = {}) => {
  const {
    method = 'GET',
    headers = {},
    body = null,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    provider = null,
  } = options

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: withTimeout(signal, timeoutMs),
      // redirect: 'error' обязателен: в заголовке едет ключ API, и следовать
      // за 302 на чужой хост значит отдать его туда вместе с запросом.
      redirect: 'error',
    })
  } catch (error) {
    throw new ProviderError('transient', `${provider ?? 'provider'}: запрос не выполнен — ${error.message}`, {
      cause: error,
      provider,
    })
  }

  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ProviderError('transient', `${provider ?? 'provider'}: ответ больше ${MAX_RESPONSE_BYTES} байт`, {
      provider,
      status: response.status,
    })
  }

  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    throw new ProviderError('transient', `${provider ?? 'provider'}: тело ответа не дочитано — ${error.message}`, {
      cause: error,
      provider,
      status: response.status,
    })
  }

  let data = null
  try {
    // Разбор не обязан удаться: страницы ошибок приходят в HTML, и это не повод
    // бросать раньше, чем провайдер посмотрит на код состояния.
    data = text ? JSON.parse(text) : null
  } catch {
    // data остаётся null — провайдер решит, ошибка это или нет.
  }

  return { status: response.status, headers: response.headers, text, data }
}

// ---------------------------------------------------------------------------
// Проверка контракта
// ---------------------------------------------------------------------------

const REQUIRED_METHODS = ['supports', 'toProviderLang', 'isConfigured', 'translate', 'usage']

/**
 * Проверяет, что объект — провайдер. Зовётся при сборке реестра, а не при
 * первом переводе: неполный провайдер иначе проявился бы как TypeError внутри
 * воркера, уже после списания символов у соседнего провайдера в той же пачке.
 */
export const assertProviderContract = (provider) => {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('translate: провайдер должен быть объектом')
  }
  if (typeof provider.code !== 'string' || !provider.code) {
    throw new TypeError('translate: у провайдера нет code')
  }
  if (typeof provider.title !== 'string' || !provider.title) {
    throw new TypeError(`translate: у провайдера ${provider.code} нет title`)
  }
  for (const name of REQUIRED_METHODS) {
    if (typeof provider[name] !== 'function') {
      throw new TypeError(`translate: провайдер ${provider.code} не реализует ${name}()`)
    }
  }
  for (const name of ['maxBatchTexts', 'maxBatchChars']) {
    if (!Number.isInteger(provider[name]) || provider[name] <= 0) {
      throw new TypeError(`translate: у провайдера ${provider.code} ${name} должен быть целым > 0`)
    }
  }
  if (!Array.isArray(provider.configFields)) {
    throw new TypeError(`translate: у провайдера ${provider.code} configFields должен быть массивом`)
  }
  return provider
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

const SQL_SETTING = `
  SELECT value, is_secret, value_ct, value_iv, value_tag FROM settings WHERE key = ?
`

// Обычное (несекретное) значение. is_secret = 0 гарантируется CHECK таблицы,
// поэтому value и шифротекст не могут быть заполнены одновременно.
const SQL_WRITE_SETTING = `
  INSERT INTO settings (key, value, is_secret, value_ct, value_iv, value_tag, preview, updated_at)
  VALUES (?, ?, 0, NULL, NULL, NULL, NULL, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE settings.is_secret = 0
`

/**
 * Строка настройки или null. Ошибку чтения гасим: конвейер перевода не должен
 * падать из-за недоступной таблицы — он должен молча работать на умолчаниях.
 */
export const readSetting = (db, key) => {
  try {
    const row = db.get(SQL_SETTING, [key])
    if (!row || row.is_secret === 1) return null
    return typeof row.value === 'string' ? row.value : null
  } catch (error) {
    console.error(`[translate] настройка ${key} не прочитана: ${error.message}`)
    return null
  }
}

/**
 * Расшифрованный секрет из settings или null.
 *
 * Порча записи (сменился APP_SECRET, побит BLOB) — это не 500: провайдер
 * просто окажется ненастроенным, реестр возьмёт следующий, а причина уйдёт
 * в лог. Пустое значение тоже null: «ключ есть, но пустой» — это не ключ.
 */
export const readSecretSettingState = (db, key, purpose) =>
  readSecretRecord(db, key, purpose, { scope: 'translate' })

export const readSecretSetting = (db, key, purpose) => {
  const inspected = readSecretSettingState(db, key, purpose)
  if (inspected.state !== SECRET_STATE.COMPLETE) return null
  return inspected.value.trim() || null
}

/**
 * Записывает несекретную настройку. Секретную строку НЕ перетирает (условие
 * в ON CONFLICT): служебные ключи конвейера секретами не бывают, а попытка
 * записать открытое значение поверх шифротекста — это либо совпадение имён,
 * либо утечка ключа в колонку value.
 */
export const writeSetting = (db, key, value, now = Date.now()) => {
  try {
    const result = db.run(SQL_WRITE_SETTING, [key, value, now])
    if (!result.changes) {
      console.error(`[translate] настройка ${key} не записана: строка помечена секретной`)
    }
    return Boolean(result.changes)
  } catch (error) {
    console.error(`[translate] настройка ${key} не записана: ${error.message}`)
    return false
  }
}

/**
 * JSON-настройка. Любая порча (не тот тип, битый JSON) отдаёт fallback:
 * настройки правит человек руками, и один лишний символ не должен
 * останавливать переводы.
 */
export const readJsonSetting = (db, key, fallback = null) => {
  const raw = readSetting(db, key)
  if (raw == null || raw === '') return fallback

  try {
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    console.error(`[translate] настройка ${key} не разобрана как JSON — взято значение по умолчанию`)
    return fallback
  }
}

export const writeJsonSetting = (db, key, value, now = Date.now()) =>
  writeSetting(db, key, JSON.stringify(value), now)
