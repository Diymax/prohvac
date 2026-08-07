// Обработка нажатий на кнопки статуса под карточкой заявки.
//
// ГРАНИЦА МОДУЛЯ. Сюда приходит уже разобранный объект update от Bot API,
// отсюда уходят вызовы Bot API и записи в базу. Проверкой подлинности запроса
// занимается маршрут (server/routes/public.telegram.js), кодированием кнопок —
// server/domain/lead-crm.js. Разделение не косметическое: обработчик нажатия
// вызывается и вебхуком, и тестом, и его нельзя держать внутри HTTP-слоя.
//
// ПОЧЕМУ ОТВЕТ ВСЕГДА 200. Telegram повторяет обновление, пока не получит
// успешный код, и делает это с нарастающей задержкой часами. Ошибка в нашей
// логике не должна превращаться в бесконечную очередь повторов, поэтому любое
// разобранное обновление считается принятым, а неудача уходит в лог.

import { createHmac } from 'node:crypto'

import { createLeadRepository } from '../repositories/leads.js'
import {
  CRM_STATUS_LABELS,
  actorName,
  decodeCallbackData,
  renderLeadCard,
} from '../domain/lead-crm.js'

/**
 * Адрес вебхука.
 *
 * Живёт в прикладном слое, а не в самом маршруте: его знают двое — маршрут,
 * который его обслуживает, и настройки, которые регистрируют его в Telegram.
 * Импорт маршрута из маршрута запрещён (см. public.boundaries.test.js), да и
 * разъехавшиеся строки означали бы вебхук, зарегистрированный не туда.
 */
export const WEBHOOK_PATH = '/api/telegram/webhook'

/**
 * Секрет для подписи кнопок и для заголовка вебхука.
 *
 * Выводится из APP_SECRET, а не заводится отдельной настройкой: лишний секрет
 * — это лишний пункт в инструкции по развёртыванию и ещё одно место, где
 * забудут его сменить. Смена APP_SECRET обесценивает старые кнопки, и это
 * правильное поведение: подпись не должна переживать ротацию ключа.
 */
export const deriveCrmSecret = (appSecret, purpose) =>
  createHmac('sha256', String(appSecret)).update(`telegram-crm:${purpose}`, 'utf8').digest('hex')

/** Секрет заголовка X-Telegram-Bot-Api-Secret-Token (допустимы A-Z a-z 0-9 _ -). */
export const webhookSecretFor = (appSecret) => deriveCrmSecret(appSecret, 'webhook').slice(0, 48)

/** Ключ подписи callback_data. */
export const callbackSecretFor = (appSecret) => deriveCrmSecret(appSecret, 'callback')

const answer = (gateway, transport, callbackQueryId, text, alert = false) =>
  gateway
    .answerCallbackQuery(
      {
        callback_query_id: callbackQueryId,
        // Без ответа кнопка в клиенте крутится до таймаута, и менеджер жмёт
        // её ещё раз, считая, что не сработало.
        text: text.slice(0, 200),
        show_alert: alert,
      },
      transport
    )
    .catch(() => null)

/**
 * Применяет одно обновление Telegram.
 *
 * @param {object} params
 * @param {object} params.db соединение из server/db/index.js
 * @param {object} params.gateway шлюз из server/integrations/telegram.js
 * @param {object} params.telegram конфигурация из resolveTelegramConfig()
 * @param {string} params.callbackSecret ключ подписи кнопок
 * @param {object} params.update тело обновления от Bot API
 * @param {Function} [params.audit] запись в журнал действий
 * @returns {Promise<{handled: boolean, reason?: string, leadId?: number,
 *                    status?: string}>}
 */
export const applyTelegramUpdate = async ({
  db,
  gateway,
  telegram,
  callbackSecret,
  update,
  audit = null,
  now = Date.now(),
}) => {
  const query = update?.callback_query
  // Бот получает и обычные сообщения из чата — на них у него нет никаких
  // обязанностей, и молча их игнорировать правильно.
  if (!query) return { handled: false, reason: 'not_a_callback' }

  const repository = createLeadRepository(db)

  const updateId = Number(update.update_id)
  if (Number.isSafeInteger(updateId) && !repository.rememberUpdate(updateId, now)) {
    // Повтор доставки того же обновления. Отвечаем на нажатие ещё раз — оно
    // могло остаться без ответа именно поэтому, — но статус не трогаем.
    return { handled: false, reason: 'duplicate_update' }
  }

  const transport = {
    botToken: telegram.botToken,
    apiBase: telegram.apiBase,
  }

  const decoded = decodeCallbackData({ secret: callbackSecret, data: query.data })
  if (!decoded.ok) {
    await answer(gateway, transport, query.id, 'Кнопка устарела — откройте админку.', true)
    return { handled: false, reason: decoded.error }
  }

  // Единственная настоящая проверка прав: карточка лежит в рабочем чате отдела
  // продаж, и нажать кнопку может только тот, кто в этом чате есть. Сверка
  // с настроенным chat_id не даёт использовать бота из чужого чата, куда его
  // кто-то добавил.
  const chatId = query.message?.chat?.id
  if (String(chatId) !== String(telegram.chatId)) {
    await answer(gateway, transport, query.id, 'Этот чат не настроен для заявок.', true)
    return { handled: false, reason: 'foreign_chat' }
  }

  const applied = repository.applyStatusFromTelegram({
    leadId: decoded.leadId,
    status: decoded.status,
    actor: actorName(query.from),
    now,
  })

  if (!applied) {
    // Срок хранения персональных данных наступает сам, а сообщение в чате
    // живёт вечно. Кнопки снимаем, чтобы по ним больше не жали.
    await answer(gateway, transport, query.id, 'Заявка удалена по сроку хранения.', true)
    await gateway
      .editMessageReplyMarkup(
        { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } },
        transport
      )
      .catch(() => null)
    return { handled: false, reason: 'lead_not_found', leadId: decoded.leadId }
  }

  if (!applied.changed) {
    await answer(gateway, transport, query.id, `Уже «${CRM_STATUS_LABELS[decoded.status]}».`)
    return { handled: true, leadId: decoded.leadId, status: decoded.status, changed: false }
  }

  await answer(gateway, transport, query.id, `Статус: ${CRM_STATUS_LABELS[decoded.status]}`)

  // Карточка перерисовывается целиком той же функцией, что и при правке
  // из админки: две сборки разъехались бы, и одна и та же заявка выглядела
  // бы в чате по-разному в зависимости от того, откуда меняли статус.
  const card = renderLeadCard({
    template: telegram.template,
    lead: applied.lead,
    status: decoded.status,
    actor: actorName(query.from),
    at: now,
    secret: callbackSecret,
  })

  const edited = await gateway.editMessageText(
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      text: card.text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: card.replyMarkup,
    },
    transport
  )

  if (!edited.ok) {
    // Статус уже сохранён — это главное. Неудачная перерисовка означает лишь
    // устаревшую подпись под карточкой, и ронять из-за неё обработку нельзя.
    console.warn(`[telegram-crm] карточка ${decoded.leadId} не обновлена: ${edited.error}`)
  }

  if (audit) {
    audit({
      at: now,
      actor: `telegram:${actorName(query.from)}`,
      action: 'lead.status_telegram',
      entityId: decoded.leadId,
      // Ни имени, ни телефона: журнал переживает заявку по сроку хранения.
      diff: { status: decoded.status, source: 'telegram' },
    })
  }

  return { handled: true, leadId: decoded.leadId, status: decoded.status, changed: true }
}
