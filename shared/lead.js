// Единый источник правил для заявки: используется и клиентом (zod-схема
// в Contact.jsx), и сервером (lead-pipeline.js). Раньше правила были продублированы
// двумя расходящимися реализациями — например, длина сообщения на клиенте
// считалась после trim, а на сервере до него.

export const NAME_MIN = 3
export const NAME_MAX = 60
export const MESSAGE_MAX = 1000

// Имя: буквы любого алфавита, пробелы, дефис, апостроф, точка.
// Заодно отсекает управляющие символы и разметку.
export const NAME_PATTERN = /^[\p{L}\p{M}\s'’.-]+$/u

// Узбекский номер: 12 цифр, начинается с 998.
export const PHONE_PATTERN = /^998\d{9}$/

export const normalizePhone = (value) => String(value ?? '').replace(/\D/g, '')

// Управляющие символы C0/C1 (включая \r и \n), разделители строк и абзацев,
// а также невидимые символы нулевой ширины.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200D\uFEFF]+/g

/**
 * Схлопывает переводы строк и управляющие символы в пробел.
 * Экранированием MarkdownV2 это не лечится: '\n' не спецсимвол разметки,
 * но позволяет дорисовать в сообщение поддельные строки («📞 Телефон: ...»),
 * которые в чате неотличимы от настоящих полей заявки.
 */
export const collapseWhitespace = (value) =>
  String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

/**
 * Проверяет заявку. Возвращает { ok: true, value } либо { ok: false, error }.
 * Значения на выходе уже нормализованы и безопасны для вставки в сообщение.
 */
export const validateLead = (input, { requireMessage = false } = {}) => {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_payload' }

  const { name, phone, message } = input
  if (typeof name !== 'string' || typeof phone !== 'string') {
    return { ok: false, error: 'invalid_payload' }
  }
  if (message != null && typeof message !== 'string') {
    return { ok: false, error: 'invalid_message' }
  }

  const cleanName = collapseWhitespace(name)
  if (cleanName.length < NAME_MIN || cleanName.length > NAME_MAX) {
    return { ok: false, error: 'invalid_name' }
  }
  if (!NAME_PATTERN.test(cleanName)) {
    return { ok: false, error: 'invalid_name' }
  }

  const digits = normalizePhone(phone)
  if (!PHONE_PATTERN.test(digits)) {
    return { ok: false, error: 'invalid_phone' }
  }

  const cleanMessage = collapseWhitespace(message ?? '')
  if (requireMessage && !cleanMessage) {
    return { ok: false, error: 'invalid_message' }
  }
  if (cleanMessage.length > MESSAGE_MAX) {
    return { ok: false, error: 'invalid_message' }
  }

  return {
    ok: true,
    value: { name: cleanName, phone: `+${digits}`, message: cleanMessage },
  }
}

// --- Идемпотентность отправки (CR-033) ---
//
// Ключ идемпотентности сам по себе ничего не гарантирует: тот же ключ,
// присланный с другой заявкой, раньше возвращал результат чужой отправки.
// Решение принимается по паре «ключ + отпечаток полезной нагрузки», а чтобы
// клиент и сервер не разошлись в том, что считать «той же заявкой»,
// каноническая форма описана здесь один раз.

/** Языки, которые сервер пишет в журнал заявок; остальные сводятся к ru. */
export const LEAD_LOCALES = Object.freeze(['ru', 'en', 'uz', 'tr', 'ar'])
export const DEFAULT_LEAD_LOCALE = 'ru'
export const PAGE_PATH_MAX = 200

export const normalizeLeadLocale = (value) => {
  const code = typeof value === 'string' ? value.slice(0, 2).toLowerCase() : ''
  return LEAD_LOCALES.includes(code) ? code : DEFAULT_LEAD_LOCALE
}

export const normalizeLeadPagePath = (value) =>
  typeof value === 'string' ? value.slice(0, PAGE_PATH_MAX) : null

// --- Атрибуция заявки ---
//
// Откуда пришёл посетитель, который оставил заявку. Собирается на клиенте
// (src/analytics/attribution.js) и хранится рядом с заявкой, чтобы воронка
// «визит → заявка» считалась по СВОИМ данным и не зависела ни от доступности
// Stat API, ни от блокировщиков, режущих счётчик.
//
// Всё поле необязательное: заявка без атрибуции — нормальная заявка, а не
// ошибка. Поэтому здесь нет ни одной проверки, способной отклонить заявку,
// — только отбрасывание того, что не похоже на значение.
//
// ЧТО ЭТО ЗА ДАННЫЕ. ymClientId — идентификатор браузера из cookie Метрики,
// а не имя человека, но он живёт по тем же правилам, что и остальная строка
// заявки: тот же purge_after, то же удаление уборщиком. Отдельного срока
// хранения для него не заводим — иначе получится «данные о заявке удалены,
// а хвост от неё остался».

export const ATTRIBUTION_VALUE_MAX = 200
export const ATTRIBUTION_REFERRER_MAX = 500

/** Поля атрибуции в порядке колонок таблицы leads. */
export const ATTRIBUTION_KEYS = Object.freeze([
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'yclid',
  'gclid',
  'ymClientId',
  'referrer',
])

const attributionLimit = (key) =>
  key === 'referrer' ? ATTRIBUTION_REFERRER_MAX : ATTRIBUTION_VALUE_MAX

/**
 * Нормализует блок атрибуции. Возвращает объект со ВСЕМИ ключами из
 * ATTRIBUTION_KEYS; отсутствующие и негодные значения — null.
 *
 * Полный набор ключей, а не только присланные: дальше значения уходят
 * позиционными параметрами в INSERT, и пропуск ключа сдвинул бы колонки.
 */
export const normalizeLeadAttribution = (input) => {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}

  return Object.fromEntries(
    ATTRIBUTION_KEYS.map((key) => {
      const raw = source[key]
      if (typeof raw !== 'string') return [key, null]
      // Те же управляющие символы, что и в остальных полях заявки: значения
      // попадают в админку и в выгрузки, перевод строки там не нужен никому.
      const clean = collapseWhitespace(raw).slice(0, attributionLimit(key))
      return [key, clean || null]
    })
  )
}

// Версия входит в каноническую строку: если набор или порядок полей когда-то
// изменится, старые отпечатки перестанут совпадать с новыми и уедут
// в конфликт, а не в ложный повтор чужой заявки.
const CANONICAL_PAYLOAD_VERSION = 'lead.v1'

/**
 * Каноническая форма заявки — основа отпечатка идемпотентности.
 *
 * Сравниваются не сырые поля формы, а нормализованные: «  Иван   Петров »
 * и «иван петров» — одна и та же заявка, и повтор после таймаута не должен
 * превращаться в конфликт из-за пробела или регистра. NFKC приводит
 * совместимые формы символов к одной, поэтому копия текста из другого
 * редактора остаётся тем же отпечатком.
 *
 * Порядок полей фиксирован, а JSON.stringify экранирует значения: склеить
 * два поля в одно через разделитель и подделать отпечаток нельзя.
 *
 * АТРИБУЦИИ ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. utm-метки и ClientID — это описание
 * визита, а не содержимое заявки. Включив их в отпечаток, мы бы получили
 * вторую заявку каждый раз, когда посетитель повторяет отправку после
 * таймаута, вернувшись на страницу по другой ссылке: поля формы те же,
 * человек тот же, а метки другие — и защита от дублей перестаёт работать
 * ровно в том сценарии, ради которого она сделана.
 */
export const canonicalLeadPayload = ({ name, phone, message, locale, pagePath } = {}) =>
  JSON.stringify([
    CANONICAL_PAYLOAD_VERSION,
    collapseWhitespace(String(name ?? '').normalize('NFKC')).toLowerCase(),
    normalizePhone(phone),
    collapseWhitespace(String(message ?? '').normalize('NFKC')),
    normalizeLeadLocale(locale),
    normalizeLeadPagePath(pagePath) ?? '',
  ])

// UUID v4 в нижнем регистре: 122 бита случайности. Публичный эндпоинт
// принимает ключ снаружи, поэтому предсказуемый ключ вида `lead-0001` —
// это возможность попасть в чужую запись, а не просто неаккуратный формат.
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isUuidV4 = (value) => typeof value === 'string' && UUID_V4_PATTERN.test(value)

/**
 * Новый ключ идемпотентности из криптостойкого источника.
 *
 * Возвращает null, если источника нет (небезопасный контект, старый браузер).
 * Тогда форма отправляет заявку без заголовка и сервер выдаёт ключ сам —
 * защита от дублей слабее, но подставлять сюда Math.random нельзя.
 */
export const randomIdempotencyKey = () => {
  const source = globalThis.crypto
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  if (typeof source?.getRandomValues !== 'function') return null

  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

export const LEAD_IDEMPOTENCY_STORAGE_KEY = 'prohvac.lead.idempotency'

const FNV_PRIME = 0x01000193

const fnv1a = (input, seed) => {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME) >>> 0
    hash = Math.imul(hash ^ (code >>> 8), FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/**
 * Отпечаток значимых полей для КЛИЕНТА: по нему форма понимает, что заявку
 * переписали и ключ пора менять.
 *
 * Это не средство защиты — решение о повторе принимает сервер по SHA-256
 * от той же канонической строки. Саму строку в sessionStorage класть нельзя:
 * в ней имя и телефон, а хранилище переживает и перезагрузку, и очистку формы.
 */
export const leadPayloadDigest = (payload) => {
  const canonical = canonicalLeadPayload(payload)
  return (
    fnv1a(canonical, 0x811c9dc5).toString(16).padStart(8, '0') +
    fnv1a(canonical, 0x9dc5811c).toString(16).padStart(8, '0')
  )
}

const readStoredIdempotency = (storage) => {
  try {
    const raw = storage?.getItem(LEAD_IDEMPOTENCY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isUuidV4(parsed?.key) && typeof parsed?.digest === 'string' ? parsed : null
  } catch {
    // Хранилище может быть недоступно (приватный режим, запрет хранения) или
    // содержать битую запись. Оба случая означают ровно «ключа нет».
    return null
  }
}

/** Забывает ключ: следующая отправка той же заявки будет новой. */
export const clearLeadIdempotencyKey = (storage) => {
  try {
    storage?.removeItem(LEAD_IDEMPOTENCY_STORAGE_KEY)
  } catch {
    // Ронять форму из-за хранилища нельзя: ключ всё равно сменится, как только
    // изменится отпечаток полей.
  }
}

/**
 * Возвращает ключ идемпотентности для текущего содержимого формы.
 *
 * Тот же набор полей — тот же ключ, поэтому повтор после таймаута, обрыва
 * связи, 5xx или delivery_unknown попадает в уже созданную заявку, а не
 * создаёт вторую. Ключ живёт в sessionStorage, то есть переживает
 * перезагрузку страницы и умирает вместе с вкладкой.
 */
export const resolveLeadIdempotencyKey = ({ storage, payload, newKey = randomIdempotencyKey }) => {
  const digest = leadPayloadDigest(payload)
  const stored = readStoredIdempotency(storage)
  if (stored && stored.digest === digest) return stored.key

  const key = newKey()
  if (!isUuidV4(key)) return null
  try {
    storage?.setItem(LEAD_IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key, digest }))
  } catch {
    // Записать не удалось — ключ уйдёт на сервер, но перезагрузку не переживёт.
    // Это ровно прежнее поведение формы, а не новая поломка.
  }
  return key
}

/** Экранирование по правилам Telegram MarkdownV2. */
export const escapeMarkdownV2 = (value) =>
  String(value ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`)

/** Собирает текст сообщения из уже провалидированных значений. */
export const buildLeadMessage = ({ name, phone, message }) => {
  const lines = [
    '📩 *Новая заявка \\(сайт PROHVAC\\)*',
    `👤 *Имя:* ${escapeMarkdownV2(name)}`,
    `📞 *Телефон:* ${escapeMarkdownV2(phone)}`,
  ]
  if (message) lines.push(`💬 *Сообщение:* ${escapeMarkdownV2(message)}`)
  return lines.join('\n')
}
