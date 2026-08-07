// Провайдер MyMemory — бесплатный фоллбэк без ключа.
//
// ЗАЧЕМ ОН НУЖЕН. У DeepL закрытый список языков, и узбекского в нём может
// не оказаться (см. шапку providers/deepl.js). Узбекская версия сайта при этом
// обязательна: это государственный язык рынка, ради которого сайт и делается.
// MyMemory переводит ru->uz бесплатно и без регистрации, качество ниже, но
// машинный перевод здесь в любом случае черновик — редактор правит его в
// админке, и правка защищена замком is_locked от перетирания.
//
// ОГРАНИЧЕНИЯ, КОТОРЫЕ ОПРЕДЕЛЯЮТ ВЕСЬ ЭТОТ ФАЙЛ:
//   - один текст на запрос (GET с параметром q), отсюда maxBatchTexts = 1;
//   - q ограничен пятью сотнями байт, отсюда маленький maxBatchChars;
//   - дневной лимит на анонимный адрес низкий (порядка нескольких тысяч слов),
//     и по его исчерпании приходит 429 либо 200 с предупреждением в теле.
//     И то и другое трактуется как 'quota': повторять сегодня бессмысленно,
//     а 'rate_limit' заставил бы воркер долбиться каждые несколько минут.

import {
  ProviderError,
  SETTINGS,
  kindForStatus,
  parseRetryAfterMs,
  readSetting,
  requestJson,
} from '../provider.js'

export const MYMEMORY_DEFAULT_BASE = 'https://api.mymemory.translated.net'

const CODE = 'mymemory'

// Строго один текст: API принимает единственный q.
const MAX_BATCH_TEXTS = 1

// q ограничен 500 байтами. Кириллица в UTF-8 — два байта на символ, значит
// безопасный потолок по символам вдвое меньше, ещё минус запас на разметку
// защищённых терминов.
const MAX_BATCH_CHARS = 220

// Языки, которые нужны лендингу. Список закрытый и захардкожен намеренно:
// у MyMemory нет эндпоинта со списком пар, а сам он отвечает «переводом»
// на что угодно, включая пары, которых не знает, — то есть спросить некого.
const SUPPORTED = Object.freeze(['en', 'uz', 'tr', 'ar'])

// Признаки исчерпанного дневного лимита в теле ответа с кодом 200.
const QUOTA_MARKERS = /MYMEMORY WARNING|QUOTA|LIMIT/i

// MyMemory возвращает текст с HTML-сущностями ('&#39;', '&quot;'), потому что
// внутри у него общая база сегментов из веба. В content_entries значение
// попадает как есть и выводится React'ом без dangerouslySetInnerHTML, то есть
// сущность отобразилась бы буквально: «&#39;» вместо апострофа.
const ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
})

const decodeEntities = (text) =>
  String(text ?? '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d{1,6});/g, (match, code) => {
      const point = Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, code) => {
      const point = Number.parseInt(code, 16)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
    })

/**
 * @param {{db: object, base?: string, email?: string}} deps
 *   email необязателен: с ним дневной лимит выше, поэтому адрес читается
 *   из settings, но отсутствие адреса — рабочий режим, а не ошибка.
 */
export const createMyMemoryProvider = (deps = {}) => {
  const { db } = deps

  const base = () => (deps.base || MYMEMORY_DEFAULT_BASE).replace(/\/+$/, '')

  const email = () => {
    if (deps.email !== undefined) return deps.email
    if (!db) return ''
    const value = readSetting(db, SETTINGS.mymemoryEmail)
    return typeof value === 'string' ? value.trim() : ''
  }

  const translate = async (texts, targetLang, options = {}) => {
    const { signal = null, now = Date.now() } = options

    if (!Array.isArray(texts) || !texts.length) return { texts: [], billedChars: 0 }
    if (texts.length > MAX_BATCH_TEXTS) {
      throw new ProviderError('bad_request', `mymemory: пачка из ${texts.length} текстов при пределе ${MAX_BATCH_TEXTS}`, {
        provider: CODE,
      })
    }

    const [text] = texts
    const query = new URLSearchParams({ q: text, langpair: `ru|${targetLang}` })
    const contact = email()
    // Параметр 'de' — контактный адрес. С ним анонимный дневной лимит
    // поднимается на порядок, без него запрос всё равно проходит.
    if (contact) query.set('de', contact)

    const response = await requestJson(`${base()}/get?${query.toString()}`, {
      signal,
      provider: CODE,
    })

    if (response.status === 429) {
      throw new ProviderError('quota', 'mymemory: дневной лимит исчерпан (HTTP 429)', {
        provider: CODE,
        status: 429,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after'), now),
      })
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(kindForStatus(response.status), `mymemory: HTTP ${response.status} ${String(response.text || '').slice(0, 200)}`, {
        provider: CODE,
        status: response.status,
      })
    }

    const data = response.data
    const details = String(data?.responseDetails ?? '')

    // Лимит исчерпан — код 200, а причина в теле. Без этой ветки ответ
    // «MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS» уехал бы
    // в content_entries как перевод.
    if (data?.quotaFinished === true || QUOTA_MARKERS.test(details)) {
      throw new ProviderError('quota', `mymemory: лимит исчерпан — ${details.slice(0, 200)}`, {
        provider: CODE,
        status: response.status,
      })
    }

    const statusCode = Number(data?.responseStatus)
    if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
      throw new ProviderError(kindForStatus(statusCode), `mymemory: responseStatus ${statusCode} ${details.slice(0, 200)}`, {
        provider: CODE,
        status: statusCode,
      })
    }

    const translated = data?.responseData?.translatedText
    if (typeof translated !== 'string' || !translated) {
      throw new ProviderError('transient', 'mymemory: в ответе нет перевода', {
        provider: CODE,
        status: response.status,
      })
    }

    return { texts: [decodeEntities(translated)], billedChars: text.length }
  }

  return {
    code: CODE,
    title: 'MyMemory',
    maxBatchTexts: MAX_BATCH_TEXTS,
    maxBatchChars: MAX_BATCH_CHARS,
    configFields: Object.freeze([
      { name: SETTINGS.mymemoryEmail, label: 'Контактный e-mail (повышает дневной лимит)', type: 'email' },
    ]),
    // Ключа нет по определению — провайдер настроен всегда.
    isConfigured: () => true,
    supports: (lang) => SUPPORTED.includes(lang),
    toProviderLang: (lang) => String(lang).toLowerCase(),
    translate,
    // Счётчика остатка у MyMemory нет: он привязан к адресу и наружу
    // не отдаётся. null означает «спрашивать не у кого», и usage.js
    // считает расход сам.
    usage: async () => null,
  }
}
