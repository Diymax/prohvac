// Локальная заглушка Telegram Bot API.
//
// ЗАЧЕМ ОНА СТРОГАЯ. Прежняя версия отвечала ok:true на ЛЮБОЙ запрос: не
// смотрела ни на токен, ни на chat_id, ни на разметку. Из-за этого локальный
// прогон ничего не доказывал — форма показывала «спасибо», заявка получала
// статус sent, в терминале печаталось сообщение, а стоило подключить
// настоящего бота, как выяснялось, что он не работал никогда. Заглушка,
// принимающая то, что отвергает Bot API, — это не удобство, а источник ложной
// уверенности.
//
// Поэтому здесь воспроизведены ровно те проверки, на которых реальный API
// отказывает: формат токена, наличие чата, разбор MarkdownV2 и предел длины.
// Ответы совпадают с настоящими по коду и по тексту description, потому что
// именно по description код в server/integrations/telegram.js различает
// причины отказа.
//
// Запуск:  node scripts/mock-telegram.mjs [порт]
// Затем в .env.local:  TELEGRAM_API_BASE=http://127.0.0.1:8788

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

import { findMarkdownV2Error, TELEGRAM_TEXT_LIMIT } from '../shared/telegram-markdown.js'

const port = Number(process.argv[2] || 8788)
const logFile = process.env.MOCK_TELEGRAM_LOG || ''

// Тот же формат, что у настоящего токена: <id бота>:<секрет>. Заглушка,
// принимающая пустую строку, скрыла бы незаполненную настройку.
const TOKEN_PATTERN = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/

const BOT_IDENTITY = Object.freeze({
  id: 7000000001,
  is_bot: true,
  first_name: 'PROHVAC Mock',
  username: 'prohvac_mock_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
})

let messageId = 1000
let updateId = 500_000

/** Всё, что «ушло в Telegram». Читается тестами через GET /__sent. */
const sent = []

const respond = (res, status, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Отказ в формате Bot API: описание разбирает вызывающий код. */
const fail = (res, status, description, parameters) =>
  respond(res, status, {
    ok: false,
    error_code: status,
    description,
    ...(parameters ? { parameters } : {}),
  })

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // Тот же предел, что у настоящего API: заглушка не должна быть местом,
      // где помещается запрос, который в проде не поместится.
      if (size > 1024 * 1024) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/**
 * sendMessage — единственный метод, где заглушка обязана быть придирчивой:
 * именно на нём ломается доставка заявок.
 */
const handleSendMessage = (res, payload) => {
  const chatId = payload.chat_id
  if (chatId === undefined || chatId === null || String(chatId).trim() === '') {
    return fail(res, 400, 'Bad Request: chat_id is empty')
  }
  // Настоящий API не знает чатов, которых нет, и отвечает именно так.
  if (!/^-?\d+$/.test(String(chatId)) && !String(chatId).startsWith('@')) {
    return fail(res, 400, 'Bad Request: chat not found')
  }

  const text = payload.text
  if (typeof text !== 'string' || text === '') {
    return fail(res, 400, 'Bad Request: message text is empty')
  }
  if (text.length > TELEGRAM_TEXT_LIMIT) {
    return fail(res, 400, 'Bad Request: message is too long')
  }

  if (payload.parse_mode === 'MarkdownV2') {
    const error = findMarkdownV2Error(text)
    if (error) {
      // Формулировка настоящего Telegram: по ней шлюз узнаёт поломанную
      // разметку и повторяет отправку простым текстом.
      return fail(
        res,
        400,
        `Bad Request: can't parse entities: Character '${error.char}' is reserved ` +
          `and must be escaped with the preceding '\\' (byte offset ${error.offset})`
      )
    }
  } else if (payload.parse_mode && payload.parse_mode !== 'HTML' && payload.parse_mode !== 'Markdown') {
    return fail(res, 400, `Bad Request: can't parse entities: Unsupported parse_mode`)
  }

  messageId += 1
  const record = {
    message_id: messageId,
    chat_id: String(chatId),
    text,
    parse_mode: payload.parse_mode ?? null,
    reply_markup: payload.reply_markup ?? null,
    at: Date.now(),
  }
  sent.push(record)
  if (sent.length > 200) sent.shift()

  console.log('--- заглушка Telegram: sendMessage принят ---')
  console.log('chat_id:', record.chat_id, '| parse_mode:', record.parse_mode)
  console.log(text)
  if (record.reply_markup) console.log('кнопки:', JSON.stringify(record.reply_markup))
  console.log('--------------------------------------------')

  if (logFile) appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8')

  return respond(res, 200, {
    ok: true,
    result: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId) || chatId, type: 'supergroup', title: 'PROHVAC mock chat' },
      text,
    },
  })
}

const handleEditMessageText = (res, payload) => {
  if (payload.parse_mode === 'MarkdownV2' && typeof payload.text === 'string') {
    const error = findMarkdownV2Error(payload.text)
    if (error) {
      return fail(
        res,
        400,
        `Bad Request: can't parse entities: Character '${error.char}' is reserved ` +
          `and must be escaped with the preceding '\\' (byte offset ${error.offset})`
      )
    }
  }

  const target = sent.find((item) => item.message_id === Number(payload.message_id))
  if (!target) return fail(res, 400, 'Bad Request: message to edit not found')

  target.text = payload.text ?? target.text
  target.reply_markup = payload.reply_markup ?? target.reply_markup
  target.edited = true

  console.log(`--- заглушка Telegram: сообщение ${target.message_id} отредактировано ---`)

  return respond(res, 200, {
    ok: true,
    result: { message_id: target.message_id, text: target.text },
  })
}

const METHODS = {
  getMe: (res) => respond(res, 200, { ok: true, result: BOT_IDENTITY }),
  getChat: (res, payload) =>
    respond(res, 200, {
      ok: true,
      result: { id: Number(payload.chat_id) || payload.chat_id, type: 'supergroup', title: 'PROHVAC mock chat' },
    }),
  sendMessage: handleSendMessage,
  editMessageText: handleEditMessageText,
  editMessageReplyMarkup: (res, payload) => {
    const target = sent.find((item) => item.message_id === Number(payload.message_id))
    if (!target) return fail(res, 400, 'Bad Request: message to edit not found')
    target.reply_markup = payload.reply_markup ?? null
    return respond(res, 200, { ok: true, result: { message_id: target.message_id } })
  },
  answerCallbackQuery: (res) => respond(res, 200, { ok: true, result: true }),
  setWebhook: (res) => respond(res, 200, { ok: true, result: true, description: 'Webhook was set' }),
  deleteWebhook: (res) => respond(res, 200, { ok: true, result: true }),
  getWebhookInfo: (res) =>
    respond(res, 200, { ok: true, result: { url: '', pending_update_count: 0 } }),
  getUpdates: (res) => respond(res, 200, { ok: true, result: [] }),
}

const server = createServer(async (req, res) => {
  // Служебные адреса заглушки. Ими пользуются тесты: проверить, что именно
  // «ушло в Telegram», иначе пришлось бы разбирать вывод в терминале.
  if (req.url === '/__sent') {
    return respond(res, 200, { ok: true, items: sent })
  }
  if (req.url === '/__reset' && req.method === 'POST') {
    sent.length = 0
    return respond(res, 200, { ok: true })
  }
  if (req.url === '/__next-update-id') {
    updateId += 1
    return respond(res, 200, { ok: true, updateId })
  }

  const match = /^\/bot([^/]+)\/([A-Za-z]+)/.exec(req.url || '')
  if (!match) return fail(res, 404, 'Not Found')

  const [, token, method] = match
  // 401 на кривой токен — обязателен: незаполненный TELEGRAM_BOT_TOKEN обязан
  // выглядеть так же, как он выглядит в проде.
  if (!TOKEN_PATTERN.test(token)) {
    return fail(res, 401, 'Unauthorized')
  }

  const handler = METHODS[method]
  if (!handler) return fail(res, 404, `Not Found: method not found`)

  let payload = {}
  try {
    const body = await readBody(req)
    payload = body ? JSON.parse(body) : {}
  } catch (error) {
    if (error.message === 'payload_too_large') return fail(res, 413, 'Request Entity Too Large')
    return fail(res, 400, 'Bad Request: invalid JSON')
  }

  return handler(res, payload)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Заглушка Telegram слушает http://127.0.0.1:${port}`)
  console.log('Проверки как у настоящего Bot API: токен, chat_id, MarkdownV2, длина.')
})
