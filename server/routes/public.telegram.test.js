import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createTelegramWebhookHandler } from './public.telegram.js'
import { callbackSecretFor, webhookSecretFor } from '../application/telegram-crm.js'
import { encodeCallbackData } from '../domain/lead-crm.js'

// Маркер обязателен: значение подходит под шаблон боевого секрета из
// scripts/secret-patterns.mjs, и без него сборка исходников отказывается
// собираться — «похоже на APP_SECRET» проверяется по значению, а не по файлу.
const APP_SECRET = 'NOT-A-REAL-SECRET-fixture-app-secret-for-tests'
const CHAT_ID = '-1001234567890'

const callbackSecret = callbackSecretFor(APP_SECRET)
const webhookSecret = webhookSecretFor(APP_SECRET)

const telegram = {
  botToken: 'fixture-token',
  chatId: CHAT_ID,
  apiBase: 'https://telegram.invalid',
  template: '📩 *Заявка*\n👤 *Имя:* {name}',
  enabled: true,
}

const reqFor = ({ method = 'POST', body = {}, headers = {} } = {}) => {
  const raw = body == null ? '' : JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : [])
  req.method = method
  req.url = '/api/telegram/webhook'
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
    'x-telegram-bot-api-secret-token': webhookSecret,
    ...headers,
  }
  req.socket = { remoteAddress: '149.154.167.220' }
  req.context = Object.freeze({
    requestId: 'webhook-test-0001',
    clientIp: '149.154.167.220',
    ipHash: 'c'.repeat(64),
    userAgent: 'TelegramBot',
    userAgentHash: 'd'.repeat(64),
    origin: null,
    timestamp: 1_700_000_000_000,
  })
  return req
}

const resFor = () => {
  const headers = new Map()
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    payload: null,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value)
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase())
    },
    removeHeader(name) {
      headers.delete(String(name).toLowerCase())
    },
    writeHead(status, value) {
      this.statusCode = status
      for (const [name, item] of Object.entries(value ?? {})) {
        headers.set(String(name).toLowerCase(), item)
      }
      return this
    },
    end(value) {
      this.writableEnded = true
      this.headersSent = true
      if (value) {
        try {
          this.payload = JSON.parse(String(value))
        } catch {
          this.payload = String(value)
        }
      }
    },
  }
}

describe('POST /api/telegram/webhook', () => {
  let db
  let gateway
  let handler
  let leadId

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)

    const info = db.run(
      `INSERT INTO leads (created_at, name, phone, message, locale, ip_hash, status, purge_after)
       VALUES (?, 'Тест Тестов', '+998900000000', '', 'ru', ?, 'new', ?)`,
      [Date.now(), 'a'.repeat(64), Date.now() + 86_400_000]
    )
    leadId = Number(info.lastInsertRowid)

    gateway = {
      answerCallbackQuery: vi.fn(async () => ({ ok: true, result: {} })),
      editMessageText: vi.fn(async () => ({ ok: true, result: {} })),
      editMessageReplyMarkup: vi.fn(async () => ({ ok: true, result: {} })),
    }

    handler = createTelegramWebhookHandler({
      db,
      telegramGateway: gateway,
      appSecret: APP_SECRET,
      resolveTelegram: () => telegram,
    })
  })

  afterEach(() => db.close())

  const callbackBody = (status, overrides = {}) => ({
    update_id: overrides.updateId ?? 11,
    callback_query: {
      id: 'cbq-42',
      from: { id: 555, username: 'manager' },
      message: { message_id: 900, chat: { id: Number(CHAT_ID) } },
      data: encodeCallbackData({ secret: callbackSecret, leadId, status }),
    },
  })

  it('применяет статус при верном секрете', async () => {
    const res = resFor()
    await handler(reqFor({ body: callbackBody('in_progress') }), res)

    expect(res.statusCode).toBe(200)
    expect(db.get('SELECT status, status_source FROM leads WHERE id = ?', [leadId])).toMatchObject({
      status: 'in_progress',
      status_source: 'telegram',
    })
  })

  // 401 подтвердил бы существование адреса и сделал бы его мишенью.
  it('отвечает неотличимо от несуществующего пути без секрета', async () => {
    const res = resFor()
    await handler(reqFor({ body: callbackBody('done'), headers: { 'x-telegram-bot-api-secret-token': '' } }), res)

    expect(res.statusCode).toBe(404)
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('new')
    expect(gateway.answerCallbackQuery).not.toHaveBeenCalled()
  })

  it('отвергает чужой секрет', async () => {
    const res = resFor()
    await handler(
      reqFor({ body: callbackBody('spam'), headers: { 'x-telegram-bot-api-secret-token': 'x'.repeat(48) } }),
      res
    )

    expect(res.statusCode).toBe(404)
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('new')
  })

  it('не отвечает на GET', async () => {
    const res = resFor()
    await handler(reqFor({ method: 'GET', body: null }), res)
    expect(res.statusCode).toBe(404)
  })

  // Telegram повторяет обновление часами, пока не получит успешный код.
  it('отвечает 200 на неразбираемое тело, чтобы не копить очередь повторов', async () => {
    const req = Readable.from([Buffer.from('{не json')])
    req.method = 'POST'
    req.url = '/api/telegram/webhook'
    req.headers = {
      'content-type': 'application/json',
      'content-length': '8',
      'x-telegram-bot-api-secret-token': webhookSecret,
    }
    req.socket = { remoteAddress: '149.154.167.220' }

    const res = resFor()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
  })

  it('отвечает 200, когда бот не настроен', async () => {
    const res = resFor()
    const bare = createTelegramWebhookHandler({
      db,
      telegramGateway: gateway,
      appSecret: APP_SECRET,
      resolveTelegram: () => ({ ...telegram, botToken: '' }),
    })
    await bare(reqFor({ body: callbackBody('done') }), res)

    expect(res.statusCode).toBe(200)
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('new')
  })

  it('пишет смену статуса в журнал действий', async () => {
    await handler(reqFor({ body: callbackBody('done') }), resFor())

    const entry = db.get(`SELECT actor, action, entity_id FROM audit_log WHERE action = 'lead.status_telegram'`)
    expect(entry).toMatchObject({ action: 'lead.status_telegram', entity_id: String(leadId) })
    expect(entry.actor).toContain('telegram:')
  })

  it('переживает сбой обработки и всё равно отвечает 200', async () => {
    gateway.answerCallbackQuery = vi.fn(async () => {
      throw new Error('сеть недоступна')
    })
    const res = resFor()
    await handler(reqFor({ body: callbackBody('done') }), res)
    expect(res.statusCode).toBe(200)
  })
})
