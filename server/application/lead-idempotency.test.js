// CR-033. Сквозная проверка идемпотентности приёма заявки: от ключа, который
// форма кладёт в sessionStorage, до строки в SQLite.
//
// Сценарий, ради которого всё это написано: клиент не дождался ответа
// (таймаут, обрыв, 5xx, перезагрузка страницы) и отправил заявку ещё раз.
// До CR-033 ключа не было вовсе — каждый повтор создавал вторую заявку,
// а переиспользованный ключ возвращал результат чужой отправки.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearLeadIdempotencyKey,
  resolveLeadIdempotencyKey,
} from '../../shared/lead.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createLeadDeliveryService } from './lead-delivery.js'
import { createLeadHandler } from './lead-pipeline.js'

const form = {
  name: 'Test User',
  phone: '+998 90 000 00 00',
  message: 'Test lead, ignore',
  locale: 'en',
  pagePath: '/',
}

const runtimeConfig = {
  telegramBotToken: 'fixture-token',
  telegramChatId: 'fixture-chat',
  telegramApiBase: 'https://telegram.invalid',
  telegramEnabled: true,
  allowedOrigins: ['https://prohvac.test'],
  rateMax: 100,
  rateWindowMs: 60_000,
  requireMessage: false,
}

const response = () => ({
  statusCode: 200,
  body: null,
  setHeader() {},
  status(code) {
    this.statusCode = code
    return this
  },
  json(value) {
    this.body = value
    return this
  },
  end() {
    return this
  },
})

const request = (body, idempotencyKey) => ({
  method: 'POST',
  body,
  socket: { remoteAddress: '203.0.113.10' },
  headers: {
    origin: 'https://prohvac.test',
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  },
})

/** Хранилище вкладки: переживает «перезагрузку страницы», но не саму вкладку. */
const sessionStorageStub = () => {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

describe('end-to-end lead submission idempotency (CR-033)', () => {
  let db
  let send

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
    send = vi.fn(async () => ({ ok: true, definitive: true, responseCode: 200, messageId: 4242 }))
  })

  afterEach(() => db.close())

  /**
   * Новый экземпляр обработчика поверх той же базы. Отдельная фабрика нужна
   * не для удобства: перезапуск процесса между запросом и повтором — часть
   * проверяемого контракта, а состояние идемпотентности обязано жить в базе.
   */
  const boot = () => {
    const delivery = createLeadDeliveryService({ db, telegramGateway: { send } })
    return createLeadHandler({
      getConfig: () => runtimeConfig,
      getRequestContext: () => ({
        requestId: '00000000-0000-4000-8000-000000000000',
        clientIp: '203.0.113.10',
        ipHash: 'a'.repeat(64),
        userAgentHash: 'b'.repeat(64),
        timestamp: 1_700_000_000_000,
      }),
      rateLimiter: { hit: () => ({ allowed: true, retryAfterSec: 60 }) },
      readBody: async (req) => ({ ok: true, value: req.body }),
      buildMessage: () => 'fixture-message',
      submitLead: (input) => delivery.submit(input),
    })
  }

  const post = async (handler, body, key) => {
    const res = response()
    await handler(request(body, key), res)
    return res
  }

  const counts = () => ({
    leads: db.get('SELECT COUNT(*) AS n FROM leads').n,
    attempts: db.get('SELECT COUNT(*) AS n FROM lead_delivery_attempts').n,
  })

  it('replays the first result after a client timeout instead of creating a second lead', async () => {
    const storage = sessionStorageStub()
    const handler = boot()

    // Сервер успел доставить, но ответ не дошёл — axios оборвал запрос
    // по таймауту, и пользователь нажал «Отправить» ещё раз.
    const key = resolveLeadIdempotencyKey({ storage, payload: form })
    await post(handler, form, key)
    const retry = await post(handler, form, resolveLeadIdempotencyKey({ storage, payload: form }))

    expect(retry.statusCode).toBe(200)
    expect(retry.body).toEqual({ ok: true, deliveryState: 'sent', duplicate: true })
    expect(send).toHaveBeenCalledOnce()
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
  })

  it('replays after a page reload, because the key outlives the page', async () => {
    const storage = sessionStorageStub()
    const handler = boot()
    await post(handler, form, resolveLeadIdempotencyKey({ storage, payload: form }))

    // Перезагрузка: React-дерево и все замыкания создаются заново,
    // sessionStorage остаётся. Пользователь заполняет форму теми же данными.
    const reloaded = resolveLeadIdempotencyKey({ storage, payload: { ...form, name: ' TEST  user ' } })
    const res = await post(handler, form, reloaded)

    expect(res.body).toMatchObject({ ok: true, duplicate: true })
    expect(send).toHaveBeenCalledOnce()
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
  })

  it('replays after a process restart between the request and the retry', async () => {
    const storage = sessionStorageStub()
    const key = resolveLeadIdempotencyKey({ storage, payload: form })
    await post(boot(), form, key)

    // Новый процесс: свежая служба доставки и свежий обработчик, та же база.
    const res = await post(boot(), form, key)

    expect(res.body).toMatchObject({ ok: true, duplicate: true })
    expect(send).toHaveBeenCalledOnce()
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
  })

  it('serves two simultaneous requests with one key as one lead and one Telegram call', async () => {
    const handler = boot()
    const key = resolveLeadIdempotencyKey({ storage: sessionStorageStub(), payload: form })
    send.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ok: true, definitive: true, responseCode: 200, messageId: 4242 }
    })

    const [first, second] = await Promise.all([
      post(handler, form, key),
      post(handler, form, key),
    ])

    expect(send).toHaveBeenCalledOnce()
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
    // Победил ровно один запрос; проигравший получил отказ, а не чужой успех.
    const outcomes = [first, second].map((res) => res.statusCode).sort()
    expect(outcomes).toEqual([200, 409])
    const loser = [first, second].find((res) => res.statusCode === 409)
    expect(loser.body).toEqual({ ok: false, error: 'delivery_in_progress' })
  })

  it('answers 409 idempotency_conflict when the key is reused for a different lead', async () => {
    const handler = boot()
    const key = resolveLeadIdempotencyKey({ storage: sessionStorageStub(), payload: form })
    await post(handler, form, key)

    const res = await post(handler, { ...form, phone: '+998 90 000 00 01' }, key)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ ok: false, error: 'idempotency_conflict' })
    expect(send).toHaveBeenCalledOnce()
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
    expect(db.get('SELECT phone FROM leads').phone).toBe('+998900000000')
  })

  it('rejects a low-entropy key without touching the database', async () => {
    const res = await post(boot(), form, 'lead-request-0001')

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: 'invalid_idempotency_key' })
    expect(send).not.toHaveBeenCalled()
    expect(counts()).toEqual({ leads: 0, attempts: 0 })
  })

  it('keeps the key after delivery_unknown and never re-sends on the replay', async () => {
    const storage = sessionStorageStub()
    const handler = boot()
    send.mockResolvedValueOnce({ ok: false, definitive: false, error: 'telegram_unreachable' })

    const key = resolveLeadIdempotencyKey({ storage, payload: form })
    const first = await post(handler, form, key)
    expect(first.statusCode).toBe(202)
    expect(first.body).toEqual({ ok: false, error: 'delivery_unknown' })

    // Форма ключ не стирала — повтор попадает в ту же заявку и не создаёт
    // вторую доставку: неизвестный исход нельзя переигрывать автоматически.
    const retry = await post(handler, form, resolveLeadIdempotencyKey({ storage, payload: form }))
    expect(retry.statusCode).toBe(202)
    expect(send).toHaveBeenCalledOnce()
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
  })

  it('starts a new submission after a confirmed success or an edited field', async () => {
    const storage = sessionStorageStub()
    const handler = boot()

    const first = await post(handler, form, resolveLeadIdempotencyKey({ storage, payload: form }))
    expect(first.body).toMatchObject({ ok: true, deliveryState: 'sent' })
    // Ровно то, что делает форма при подтверждённой доставке.
    clearLeadIdempotencyKey(storage)

    await post(handler, form, resolveLeadIdempotencyKey({ storage, payload: form }))
    expect(counts()).toEqual({ leads: 2, attempts: 2 })

    // Правка значимого поля тоже даёт новый ключ и новую заявку.
    const edited = { ...form, message: 'Second test lead, ignore' }
    await post(handler, edited, resolveLeadIdempotencyKey({ storage, payload: edited }))
    expect(counts()).toEqual({ leads: 3, attempts: 3 })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('leaks no external identifier even though the attempt stores one', async () => {
    const handler = boot()
    const key = resolveLeadIdempotencyKey({ storage: sessionStorageStub(), payload: form })
    const first = await post(handler, form, key)
    const replay = await post(handler, form, key)

    expect(db.get('SELECT telegram_message_id AS id FROM lead_delivery_attempts').id).toBe(4242)
    for (const res of [first, replay]) {
      expect(JSON.stringify(res.body)).not.toContain('4242')
      expect(Object.keys(res.body).sort()).toEqual(['deliveryState', 'duplicate', 'ok'])
    }
  })
})
