// Вебхук Telegram: POST /api/telegram/webhook.
//
// ЭТО ЕДИНСТВЕННЫЙ НЕАУТЕНТИФИЦИРОВАННЫЙ ПИШУЩИЙ АДРЕС В ПРОЕКТЕ, и отсюда
// почти все решения файла:
//
//   - подлинность проверяется заголовком X-Telegram-Bot-Api-Secret-Token,
//     который Telegram присылает на каждый запрос. Значение сверяется за
//     постоянное время и выводится из APP_SECRET, а не хранится отдельной
//     настройкой: лишний секрет — это лишний пункт инструкции, который забудут
//     сменить;
//   - неверный секрет отвечает тем же uniform404, что и любой несуществующий
//     путь: 401 подтвердил бы, что адрес существует, и превратил бы его
//     в мишень для перебора;
//   - обработка идёт ДО ответа, но любой её исход — это 200. Telegram
//     повторяет обновление часами, пока не получит успех, и наша собственная
//     ошибка не должна превращаться в бесконечную очередь повторов;
//   - CSRF здесь неприменим принципиально: Telegram не присылает ни Origin,
//     ни Sec-Fetch-Site, ни куки. Защиту даёт секрет заголовка, а не источник.
//
// ПРО TRUSTED_HOSTS. Telegram обращается по имени из PUBLIC_ORIGIN, поэтому
// отдельной настройки не требуется; на чужом Host запрос отсечёт общая
// проверка в server/app.js раньше этого модуля.

import { timingSafeEqual } from 'node:crypto'

import {
  WEBHOOK_PATH,
  applyTelegramUpdate,
  callbackSecretFor,
  webhookSecretFor,
} from '../application/telegram-crm.js'
import { resolveTelegramConfig } from '../application/telegram-config.js'
import { getDb } from '../db/index.js'
import { readJson } from '../http/body.js'
import { json, uniform404 } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { telegramGateway } from '../integrations/telegram.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import { config } from '../config.js'

export { WEBHOOK_PATH }

// Обновление Bot API — это несколько килобайт в худшем случае (длинное
// сообщение с разметкой). 64 КБ с запасом покрывают его и при этом не дают
// превратить открытый адрес в приёмник произвольных объёмов.
const BODY_LIMIT = 64 * 1024

// Один чат отдела продаж физически не создаёт больше нескольких нажатий
// в секунду. Лимит защищает не от Telegram, а от того, кто узнает и адрес,
// и секрет.
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 120

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, NULL, ?, ?, 'lead', ?, NULL, ?, ?)
`

const secretMatches = (expected, received) => {
  const a = Buffer.from(String(expected), 'utf8')
  const b = Buffer.from(String(received ?? ''), 'utf8')
  // Длины сравниваются отдельно: timingSafeEqual бросает на разной длине,
  // а сама длина секретом не является.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const limiters = new WeakMap()

const limiterFor = (db) => {
  let limiter = limiters.get(db)
  if (!limiter) {
    limiter = createRateLimiter(db)
    limiters.set(db, limiter)
  }
  return limiter
}

export const createTelegramWebhookHandler = (deps = {}) => {
  const db = deps.db || getDb()
  const gateway = deps.telegramGateway || telegramGateway
  const appSecret = deps.appSecret || config.appSecret
  const webhookSecret = deps.webhookSecret || webhookSecretFor(appSecret)
  const callbackSecret = deps.callbackSecret || callbackSecretFor(appSecret)
  const resolveTelegram = deps.resolveTelegram || (() => resolveTelegramConfig(db))

  const audit = (entry) => {
    try {
      db.run(SQL_AUDIT, [
        entry.at ?? Date.now(),
        entry.actor,
        entry.action,
        entry.entityId == null ? null : String(entry.entityId),
        entry.diff == null ? null : JSON.stringify(entry.diff),
        entry.result ?? 'ok',
      ])
    } catch (error) {
      console.error(`[telegram-webhook] аудит не записан: ${error.message}`)
    }
  }

  return async (req, res) => {
    if (req.method !== 'POST') {
      await uniform404(req, res)
      return
    }

    if (!secretMatches(webhookSecret, req.headers['x-telegram-bot-api-secret-token'])) {
      // Неотличимо от несуществующего пути — см. шапку файла.
      await uniform404(req, res)
      return
    }

    const context = ensureRequestContext(req)
    const limit = limiterFor(db).hit(`tg-webhook:${context.ipHash || 'unknown'}`, {
      windowMs: RATE_WINDOW_MS,
      max: RATE_MAX,
    })
    if (!limit.allowed) {
      json(res, 429, { ok: false })
      return
    }

    const body = await readJson(req, { limit: BODY_LIMIT })
    if (!body.ok) {
      // Тело, которое мы не смогли разобрать, не станет разбираемым при
      // повторе, поэтому 200: иначе Telegram будет слать его часами.
      json(res, 200, { ok: true })
      return
    }

    const telegram = resolveTelegram()
    if (!telegram.botToken || !telegram.chatId) {
      json(res, 200, { ok: true })
      return
    }

    try {
      await applyTelegramUpdate({
        db,
        gateway,
        telegram,
        callbackSecret,
        update: body.value,
        audit,
      })
    } catch (error) {
      // Ответ всё равно 200: повтор того же обновления упадёт так же, а
      // очередь Telegram встанет колом за ним.
      console.error(`[telegram-webhook] обработка не удалась: ${error.message}`)
    }

    json(res, 200, { ok: true })
  }
}

/**
 * Вешает вебхук на публичный роутер API.
 *
 * @param {{register: Function}} router роутер из server/router.js
 * @param {object} deps
 */
export const registerTelegramWebhookRoute = (router, deps = {}) => {
  if (!router || typeof router.register !== 'function') {
    throw new TypeError('public.telegram: ожидается роутер из server/router.js')
  }
  // ALL, а не POST: на GET нужен тот же uniform404, что и на любой чужой путь,
  // а зарегистрированный только POST отдал бы на GET ответ роутера «метод
  // не поддержан» и тем самым подтвердил бы существование адреса.
  router.register('ALL', WEBHOOK_PATH, createTelegramWebhookHandler(deps))
  return router
}
