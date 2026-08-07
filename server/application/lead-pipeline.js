// Транспортно-независимый конвейер приёма заявки.
//
// CR-036. Модуль лежал в api/lead.js и экспортировал готовый обработчик по
// умолчанию — платформы вроде Vercel монтируют каталог api/ автоматически,
// поэтому у одного эндпоинта существовали два production-рантайма с разным
// поведением: один писал заявку в SQLite с долговечными попытками доставки
// и идемпотентностью, другой брал настройки из окружения, считал лимит
// в памяти процесса и не сохранял заявку вовсе. Единственный поддерживаемый
// рантайм — Node-приложение; конвейер остался отдельной функцией только
// потому, что его использует маршрут server/routes/public.lead.js.
//
// Ни персистентность, ни внешняя доставка не выполняются, пока не пройдены
// все проверки запроса и конфигурации.

import { randomUUID } from 'node:crypto'

import {
  isUuidV4,
  normalizeLeadAttribution,
  normalizeLeadLocale,
  normalizeLeadPagePath,
  validateLead,
} from '../../shared/lead.js'
import { applyCors, buildAllowedOrigins } from '../../shared/origin.js'

export const LEAD_BODY_MAX_BYTES = 8 * 1024
export const LEAD_RATE_MAX = 5
export const LEAD_RATE_WINDOW_MS = 60_000
export const DEFAULT_TELEGRAM_API = 'https://api.telegram.org'


// CR-036. Раньше здесь жил envDeps: конфигурация из process.env, лимитер
// в памяти процесса и доставка, которая никуда не сохраняла заявку. Это был
// второй production-рантайм того же эндпоинта с другим бизнес-поведением.
// Теперь зависимости обязательны: конвейер не умеет работать «сам по себе»,
// и незаполненная зависимость падает на старте, а не в обработке заявки.
const requireDep = (deps, name) => {
  const value = deps[name]
  if (typeof value !== 'function' && !(name === 'rateLimiter' && value)) {
    throw new TypeError(`lead pipeline: обязательная зависимость ${name} не передана`)
  }
  return value
}

const isJson = (contentType) =>
  /^application\/json(?:\s*;\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=[^;]+)*\s*$/i.test(contentType)

/**
 * CR-033. Ключ приходит из интернета, поэтому проверка не про формат, а про
 * энтропию: прежнее `[A-Za-z0-9._:-]{8,128}` пропускало `lead-0001`, и подбор
 * такого ключа возвращал состояние чужой отправки. Принимается только UUID v4
 * (122 бита) — ровно то, что выдают crypto.randomUUID() в форме и requestId
 * на сервере, поэтому серверные ключи, включая повтор из админки, проходят.
 *
 * Регистр приводится к нижнему: один и тот же UUID в разном регистре — один
 * ключ, иначе повтор создал бы вторую заявку.
 */
const idempotencyKeyFor = (req, context) => {
  const raw = req.headers['idempotency-key']
  if (raw == null || raw === '') return { ok: true, value: context.requestId || randomUUID() }
  if (Array.isArray(raw)) return { ok: false }
  const value = String(raw).trim().toLowerCase()
  if (!isUuidV4(value)) return { ok: false }
  return { ok: true, value }
}

// Атрибуция сюда попадает, но в отпечаток идемпотентности — нет: он считается
// по canonicalLeadPayload(), где её нет намеренно (см. shared/lead.js).
const metadataFrom = (body) => ({
  locale: normalizeLeadLocale(body.locale),
  pagePath: normalizeLeadPagePath(body.pagePath),
  attribution: normalizeLeadAttribution(body.attribution),
})

/**
 * Тело ответа собирается перечислением полей, а не переносом result целиком:
 * во внутреннем результате есть messageId из Telegram, и публичному клиенту
 * внешние идентификаторы не отдаются ни при первой отправке, ни при повторе.
 */
const responseForDelivery = (res, result) => {
  if (result.ok) {
    return res.status(200).json({
      ok: true,
      deliveryState: result.state || 'sent',
      duplicate: Boolean(result.duplicate),
    })
  }
  if (result.error === 'delivery_in_progress') {
    return res.status(409).json({ ok: false, error: result.error })
  }
  if (result.state === 'delivery_unknown' || result.error === 'delivery_unknown') {
    return res.status(202).json({ ok: false, error: 'delivery_unknown' })
  }
  return res.status(502).json({ ok: false, error: result.error || 'telegram_failed' })
}

/**
 * Required order:
 * context -> method -> Origin -> type -> size -> rate -> parse -> validate ->
 * delivery readiness -> durable create/delivery.
 */
export const createLeadHandler = (deps = {}) => {
  const getConfig = requireDep(deps, 'getConfig')
  const rateLimiter = requireDep(deps, 'rateLimiter')
  const getRequestContext = requireDep(deps, 'getRequestContext')
  const readBody = requireDep(deps, 'readBody')
  const submitLead = requireDep(deps, 'submitLead')
  const buildMessage = requireDep(deps, 'buildMessage')

  return async (req, res) => {
    const context = getRequestContext(req)
    if (context?.requestId) res.setHeader('X-Request-Id', context.requestId)

    if (req.method !== 'POST' && req.method !== 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS')
      return res.status(405).json({ ok: false, error: 'method_not_allowed' })
    }

    let config
    try {
      config = getConfig()
    } catch {
      return res.status(503).json({ ok: false, error: 'not_configured' })
    }
    let allowedOrigins
    try {
      allowedOrigins = buildAllowedOrigins({
        extraOrigins: config.allowedOrigins || [],
        allowHttp: true,
      })
    } catch {
      return res.status(503).json({ ok: false, error: 'not_configured' })
    }
    const cors = applyCors(req, res, allowedOrigins, {
      headers: 'Content-Type, Idempotency-Key',
    })
    if (!cors.allowed) {
      return res.status(403).json({ ok: false, error: 'origin_not_allowed' })
    }
    if (req.method === 'OPTIONS') return res.status(204).end()

    const contentType = String(req.headers['content-type'] || '')
    if (!isJson(contentType)) {
      return res.status(415).json({ ok: false, error: 'unsupported_media_type' })
    }

    const declaredRaw = req.headers['content-length']
    const declared = declaredRaw == null || declaredRaw === '' ? 0 : Number(declaredRaw)
    if (!Number.isFinite(declared) || declared < 0) {
      return res.status(400).json({ ok: false, error: 'invalid_content_length' })
    }
    if (declared > LEAD_BODY_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'payload_too_large' })
    }

    const max = Number.isInteger(config.rateMax) ? config.rateMax : LEAD_RATE_MAX
    const windowMs = Number.isInteger(config.rateWindowMs)
      ? config.rateWindowMs
      : LEAD_RATE_WINDOW_MS
    const limit = rateLimiter.hit(context.ipHash || context.clientIp || 'unknown', {
      max,
      windowMs,
      now: context.timestamp,
    })
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec || Math.ceil(windowMs / 1000)))
      return res.status(429).json({ ok: false, error: 'rate_limited' })
    }

    const body = await readBody(req, { maxBytes: LEAD_BODY_MAX_BYTES })
    if (!body.ok) {
      return res.status(body.error === 'payload_too_large' ? 413 : 400).json({
        ok: false,
        error: body.error,
      })
    }

    const validated = validateLead(body.value, { requireMessage: config.requireMessage === true })
    if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error })

    if (!config.telegramBotToken || !config.telegramChatId || config.telegramEnabled === false) {
      return res.status(503).json({ ok: false, error: 'not_configured' })
    }

    const idempotency = idempotencyKeyFor(req, context)
    if (!idempotency.ok) {
      return res.status(400).json({ ok: false, error: 'invalid_idempotency_key' })
    }

    // Метаданные считаются один раз: они нужны и записи заявки, и тексту
    // сообщения, а два вызова normalizeLeadAttribution на один запрос —
    // лишняя работа на горячем пути.
    const metadata = metadataFrom(body.value)

    let result
    try {
      result = await submitLead({
        lead: validated.value,
        context,
        metadata,
        idempotencyKey: idempotency.value,
        telegram: {
          botToken: config.telegramBotToken,
          chatId: config.telegramChatId,
          apiBase: config.telegramApiBase || DEFAULT_TELEGRAM_API,
        },
        config,
        // Язык передаётся явно: validateLead() возвращает только name/phone/
        // message, поэтому плейсхолдер {lang} в шаблоне молча заполнялся
        // значением по умолчанию 'ru' для любой заявки. В базе язык при этом
        // сохранялся правильно — расходились именно карточка в чате и журнал,
        // и менеджер звонил арабскому клиенту по-русски ровно в том случае,
        // ради которого поле и заводилось.
        text: buildMessage({ ...validated.value, locale: metadata.locale }),
      })
    } catch (error) {
      // Тот же ключ с другой заявкой. Отвечать состоянием прежней отправки
      // нельзя — это чужие данные; принять как новую тоже нельзя — ключ занят.
      if (error?.code === 'idempotency_conflict') {
        return res.status(409).json({ ok: false, error: 'idempotency_conflict' })
      }
      throw error
    }
    return responseForDelivery(res, result)
  }
}
