import {
  LEAD_BODY_MAX_BYTES,
  LEAD_RATE_MAX,
  LEAD_RATE_WINDOW_MS,
  createLeadHandler,
} from '../application/lead-pipeline.js'
import { SETTING_KEYS } from '../../shared/settings.js'
import { createLeadDeliveryService } from '../application/lead-delivery.js'
import { settingsSnapshot } from '../application/settings-service.js'
import { resolveTelegramConfig } from '../application/telegram-config.js'
import { callbackSecretFor } from '../application/telegram-crm.js'
import { buildStatusKeyboard } from '../domain/lead-crm.js'
import { renderLeadMessage } from '../domain/lead-message.js'
import { getDb } from '../db/index.js'
import { readJson } from '../http/body.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { telegramGateway } from '../integrations/telegram.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import { config } from '../config.js'

// Значение уже проверено схемой на записи, но строку в таблице может поправить
// и рука с sqlite3: границы проверяются повторно, иначе кривой лимит попал бы
// прямо в лимитер приёма заявок.
const safeInt = (value, fallback, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback

/**
 * Конфигурация приёма заявки одним неизменяемым объектом.
 *
 * Все значения берутся из одного снимка настроек, поэтому принадлежат одной
 * ревизии таблицы: правка настройки посреди обработки не может дать лимит
 * от старой конфигурации и шаблон от новой.
 *
 * Объект СОДЕРЖИТ ТОКЕН БОТА и целиком уходит в конвейер доставки; в ответ
 * клиенту, в лог и в аудит он не попадает.
 */
export const resolveLeadRuntimeConfig = (db) => {
  const telegram = resolveTelegramConfig(db)
  const values = settingsSnapshot(db).values

  return Object.freeze({
    telegramBotToken: telegram.botToken || '',
    telegramChatId: telegram.chatId || '',
    telegramApiBase: telegram.apiBase,
    telegramEnabled: telegram.enabled !== false,
    allowedOrigins: config.allowedOrigins,
    template: telegram.template || null,
    rateMax: safeInt(values[SETTING_KEYS.LEAD_RATE_MAX], LEAD_RATE_MAX, 1, 1_000),
    rateWindowMs: safeInt(
      values[SETTING_KEYS.LEAD_RATE_WINDOW_MS],
      LEAD_RATE_WINDOW_MS,
      1_000,
      3_600_000
    ),
    requireMessage: values[SETTING_KEYS.FORM_REQUIRE_MESSAGE] === true,
  })
}

export const createProdLeadHandler = (deps = {}) => {
  const db = deps.db || getDb()
  const limiter = deps.rateLimiter || createRateLimiter(db)
  const delivery =
    deps.deliveryService ||
    createLeadDeliveryService({
      db,
      telegramGateway: deps.telegramGateway || telegramGateway,
    })

  const resolveConfig = deps.getConfig || (() => resolveLeadRuntimeConfig(db))

  // Один раз на обработчик: ключ выводится из APP_SECRET и в течение жизни
  // процесса не меняется, а HMAC на каждую кнопку каждой заявки — лишняя
  // работа на горячем пути приёма.
  const callbackSecret = deps.callbackSecret || callbackSecretFor(config.appSecret)

  const rateLimiter = {
    hit: (key, policy) => {
      const result = limiter.hit(`lead:${key}`, policy)
      return {
        allowed: result.allowed,
        retryAfterSec: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000)),
      }
    },
  }

  return async (req, res) => {
    // Снимок конфигурации делается один раз на запрос и живёт в замыкании
    // этого обработчика. Конвейер спрашивает конфигурацию в начале обработки,
    // а текст сообщения собирается уже после чтения тела — между этими
    // моментами настройки могут смениться, и без общего снимка заявка ушла бы
    // старому боту с новым шаблоном (или наоборот).
    //
    // Замыкание, а не поле модуля: параллельные запросы обязаны иметь каждый
    // свой снимок.
    let snapshot = null
    const getConfig = () => (snapshot ??= Object.freeze({ ...resolveConfig() }))

    const handle = createLeadHandler({
      getConfig,
      getRequestContext: ensureRequestContext,
      rateLimiter,
      readBody: (request, { maxBytes = LEAD_BODY_MAX_BYTES } = {}) =>
        readJson(request, { limit: maxBytes }),
      buildMessage: (lead) => renderLeadMessage(getConfig().template, lead),
      // Клавиатура добавляется здесь, а не в конвейере: конвейер транспортно
      // независим и про Telegram знать не обязан, а id заявки существует
      // только после записи в базу — отсюда функция, а не готовое значение.
      submitLead: (input) =>
        delivery.submit({
          ...input,
          replyMarkupFor: (leadId) =>
            buildStatusKeyboard({ secret: callbackSecret, leadId, current: 'new' }),
        }),
    })

    return handle(req, res)
  }
}
