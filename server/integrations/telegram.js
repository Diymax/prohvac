// Шлюз к Telegram Bot API.
//
// ПОЧЕМУ ЗДЕСЬ СТОЛЬКО РАЗБОРА ОШИБОК. Прежняя версия сводила любой отказ
// к одному коду `telegram_failed`, и оператор видел в админке строку, по которой
// нельзя понять, что чинить: протухший токен, чат, из которого выгнали бота,
// и опечатка в шаблоне выглядели одинаково. Bot API при этом отвечает вполне
// конкретно — и HTTP-кодом, и описанием, — поэтому классификация делается один
// раз здесь, а не пересказывается в каждом вызывающем модуле.
//
// ОТДЕЛЬНО ПРО РАЗМЕТКУ. Сообщение уходит с parse_mode=MarkdownV2, и один
// неэкранированный служебный символ в шаблоне отменяет доставку целиком: API
// отвечает 400 «can't parse entities». Раньше заявка в этом случае просто
// не доходила. Теперь такой отказ не финальный — повтор уходит без parse_mode,
// то есть карточка теряет жирный шрифт, но доходит. Заявка с потерянным
// форматированием несравнимо лучше, чем заявка, которой нет.
//
// Токен не попадает ни в результат, ни в лог, ни в текст ошибки: URL с ним
// нигде не печатается, а описание от Telegram чистится safeDescription().

import { stripMarkdownV2, TELEGRAM_TEXT_LIMIT } from '../../shared/telegram-markdown.js'

export const DEFAULT_API_BASE = 'https://api.telegram.org'
const DEFAULT_TIMEOUT_MS = 8_000

const safeDescription = (value) =>
  String(value ?? '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .slice(0, 200)

/**
 * Адрес Bot API официальный?
 *
 * Нужно ровно для одного: заявка, «успешно отправленная» в локальную заглушку,
 * обязана отличаться от заявки, дошедшей до Telegram. Именно на этом различии
 * держится доверие к слову «отправлено» в админке.
 */
export const isOfficialApiBase = (apiBase) => {
  try {
    const url = new URL(String(apiBase || DEFAULT_API_BASE))
    return url.protocol === 'https:' && url.hostname === 'api.telegram.org'
  } catch {
    return false
  }
}

/**
 * Код ошибки по ответу Bot API.
 *
 * Возвращаемые коды — это то, что увидит оператор, поэтому они описывают
 * причину, а не факт неудачи.
 */
const classify = (status, description) => {
  const text = String(description || '').toLowerCase()

  if (status === 401) return 'telegram_unauthorized'
  if (status === 429) return 'telegram_rate_limited'
  if (text.includes('parse entities') || text.includes('end of the entity')) {
    return 'telegram_bad_markup'
  }
  if (text.includes('chat not found')) return 'telegram_chat_not_found'
  if (status === 403 || text.includes('bot was kicked') || text.includes('bot was blocked')) {
    return 'telegram_forbidden'
  }
  if (text.includes('message is too long')) return 'telegram_too_long'
  return 'telegram_failed'
}

/**
 * Один вызов метода Bot API.
 *
 * Сетевой отказ намеренно НЕ финальный: запрос мог дойти до Telegram, даже если
 * ответ до нас не добрался, и считать такую отправку неудачной значит однажды
 * прислать клиенту вторую карточку на ту же заявку.
 */
const callApi = async (method, payload, options) => {
  const {
    botToken,
    apiBase = DEFAULT_API_BASE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options

  if (!botToken) {
    return { ok: false, definitive: true, error: 'not_configured', responseCode: null }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)

    // Bot API отвечает HTTP 200 с ok:false. Без второй половины условия такой
    // ответ считался бы доставкой, а заявка тихо терялась бы.
    if (!response.ok || !data?.ok) {
      const description = safeDescription(data?.description)
      return {
        ok: false,
        definitive: true,
        error: classify(response.status, description),
        responseCode: response.status,
        description,
        // Группа, повышенная до супергруппы, меняет идентификатор. Telegram
        // сообщает новый ровно один раз — в теле этой ошибки. Потеряв его,
        // доставку уже не восстановить без ручного похода в настройки.
        migrateToChatId: data?.parameters?.migrate_to_chat_id ?? null,
        retryAfterSec: data?.parameters?.retry_after ?? null,
      }
    }

    return { ok: true, definitive: true, responseCode: response.status, result: data.result }
  } catch (error) {
    return {
      ok: false,
      definitive: false,
      error: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      responseCode: null,
      description: '',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Шлюз Telegram. Все внешние вызовы проекта идут через него: раньше рядом жила
 * вторая копия отправки в admin.settings.js, и самопроверка бота ходила в API
 * не тем же способом, что сама заявка, — то есть проверяла не то.
 */
export const createTelegramGateway = ({ fetchImpl = globalThis.fetch } = {}) => {
  const call = (method, payload, options = {}) =>
    callApi(method, payload, { fetchImpl, ...options })

  const send = async (options) => {
    const {
      botToken,
      chatId,
      text,
      apiBase = DEFAULT_API_BASE,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      replyMarkup = null,
      parseMode = 'MarkdownV2',
    } = options

    if (!botToken || !chatId) {
      return { ok: false, definitive: true, error: 'not_configured', responseCode: null }
    }

    const basePayload = {
      chat_id: chatId,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }
    const transport = { botToken, apiBase, timeoutMs }

    // Обрезаем ДО отправки: Telegram отвергает всё сообщение целиком, а
    // экранирование MarkdownV2 способно почти удвоить длину пользовательского
    // текста, поэтому предел достижим на вполне обычной заявке.
    const trimmed =
      String(text ?? '').length > TELEGRAM_TEXT_LIMIT
        ? `${String(text).slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`
        : String(text ?? '')

    const first = await call(
      'sendMessage',
      { ...basePayload, text: trimmed, ...(parseMode ? { parse_mode: parseMode } : {}) },
      transport
    )

    if (first.ok) {
      return {
        ok: true,
        definitive: true,
        responseCode: first.responseCode,
        messageId: first.result?.message_id ?? null,
        degraded: false,
      }
    }

    // Разметку сломал шаблон, а не заявка. Повтор без parse_mode доставляет
    // ту же информацию простым текстом — с пометкой degraded, чтобы оператор
    // увидел в админке, что шаблон надо чинить.
    if (parseMode && first.error === 'telegram_bad_markup') {
      const plain = await call(
        'sendMessage',
        { ...basePayload, text: stripMarkdownV2(trimmed) },
        transport
      )
      if (plain.ok) {
        return {
          ok: true,
          definitive: true,
          responseCode: plain.responseCode,
          messageId: plain.result?.message_id ?? null,
          degraded: true,
          description: first.description,
        }
      }
      return { ...plain, degraded: true }
    }

    return first
  }

  return {
    send,
    call,
    /** Кто мы для Telegram. Единственная проверка токена, не пишущая в чат. */
    getMe: (options) => call('getMe', {}, options),
    /** Виден ли боту чат. Отвечает на «почему заявки не приходят» без отправки. */
    getChat: (chatId, options) => call('getChat', { chat_id: chatId }, options),
    editMessageText: (payload, options) => call('editMessageText', payload, options),
    editMessageReplyMarkup: (payload, options) => call('editMessageReplyMarkup', payload, options),
    answerCallbackQuery: (payload, options) => call('answerCallbackQuery', payload, options),
    setWebhook: (payload, options) => call('setWebhook', payload, options),
    deleteWebhook: (payload, options) => call('deleteWebhook', payload ?? {}, options),
    getWebhookInfo: (options) => call('getWebhookInfo', {}, options),
    getUpdates: (payload, options) => call('getUpdates', payload, options),
  }
}

export const telegramGateway = createTelegramGateway()
