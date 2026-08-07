import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachResponseHelpers } from '../../shared/http-compat.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createProdLeadHandler } from './public.lead.js'

const valid = {
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
  template: null,
  rateMax: 5,
  rateWindowMs: 60_000,
  requireMessage: false,
}

const reqFor = ({
  method = 'POST',
  body = valid,
  headers = {},
  requestId = 'integration-request-0001',
} = {}) => {
  const raw = body == null ? '' : JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : [])
  req.method = method
  req.url = '/api/lead'
  req.headers = {
    origin: 'https://prohvac.test',
    'content-type': 'application/json',
    ...(raw ? { 'content-length': String(Buffer.byteLength(raw)) } : {}),
    ...headers,
  }
  req.socket = { remoteAddress: '203.0.113.44' }
  req.context = Object.freeze({
    requestId,
    clientIp: '203.0.113.44',
    ipHash: 'a'.repeat(64),
    userAgent: 'lead-integration-test',
    userAgentHash: 'b'.repeat(64),
    origin: req.headers.origin || null,
    timestamp: 1_700_000_000_000,
  })
  return req
}

const resFor = () => {
  const headers = new Map()
  const res = {
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
    end(value) {
      this.writableEnded = true
      this.headersSent = true
      if (value) this.payload = JSON.parse(String(value))
    },
  }
  return attachResponseHelpers(res)
}

describe('production lead adapter', () => {
  let db
  let send
  let rateLimiter
  let handler

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
    send = vi.fn(async () => ({
      ok: true,
      definitive: true,
      responseCode: 200,
      messageId: 501,
    }))
    rateLimiter = {
      hit: vi.fn(() => ({
        allowed: true,
        resetAt: Date.now() + 60_000,
      })),
    }
    handler = createProdLeadHandler({
      db,
      telegramGateway: { send },
      rateLimiter,
      getConfig: () => runtimeConfig,
    })
  })

  afterEach(() => db.close())

  const counts = () => ({
    leads: db.get('SELECT COUNT(*) AS n FROM leads').n,
    attempts: db.get('SELECT COUNT(*) AS n FROM lead_delivery_attempts').n,
  })

  const rejectWithoutStorage = async (req, status, error) => {
    const res = resFor()
    await handler(req, res)
    expect(res.statusCode).toBe(status)
    expect(res.payload.error).toBe(error)
    expect(counts()).toEqual({ leads: 0, attempts: 0 })
    expect(send).not.toHaveBeenCalled()
  }

  it('stores nothing for wrong method, Origin, type, or declared size', async () => {
    await rejectWithoutStorage(reqFor({ method: 'PUT' }), 405, 'method_not_allowed')
    await rejectWithoutStorage(
      reqFor({ headers: { origin: 'https://evil.test' } }),
      403,
      'origin_not_allowed'
    )
    await rejectWithoutStorage(
      reqFor({ headers: { 'content-type': 'text/plain' } }),
      415,
      'unsupported_media_type'
    )
    await rejectWithoutStorage(
      reqFor({ headers: { 'content-length': '9000' } }),
      413,
      'payload_too_large'
    )
  })

  it('allows Node preflight for the primary and additional configured origins', async () => {
    handler = createProdLeadHandler({
      db,
      telegramGateway: { send },
      rateLimiter,
      getConfig: () => ({
        ...runtimeConfig,
        allowedOrigins: ['https://main.example', 'https://extra.example'],
      }),
    })

    for (const origin of ['https://main.example', 'https://extra.example']) {
      const res = resFor()
      await handler(reqFor({ method: 'OPTIONS', body: null, headers: { origin } }), res)
      expect(res.statusCode).toBe(204)
      expect(res.getHeader('access-control-allow-origin')).toBe(origin)
    }
    expect(counts()).toEqual({ leads: 0, attempts: 0 })
    expect(rateLimiter.hit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('stores nothing when the rate limit is exhausted', async () => {
    rateLimiter.hit.mockReturnValueOnce({ allowed: false, resetAt: Date.now() + 5_000 })
    await rejectWithoutStorage(reqFor(), 429, 'rate_limited')
  })

  it('stores nothing for an invalid phone', async () => {
    await rejectWithoutStorage(
      reqFor({ body: { ...valid, phone: '+7 900 000 00 00' } }),
      400,
      'invalid_phone'
    )
  })

  it('stores nothing when Telegram configuration is absent', async () => {
    handler = createProdLeadHandler({
      db,
      telegramGateway: { send },
      rateLimiter,
      getConfig: () => ({ ...runtimeConfig, telegramBotToken: '' }),
    })
    await rejectWithoutStorage(reqFor(), 503, 'not_configured')
  })

  it('creates one lead and one sent attempt for a valid request', async () => {
    const res = resFor()
    await handler(reqFor({ headers: { 'idempotency-key': '11111111-1111-4111-8111-111111111111' } }), res)
    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({ ok: true, deliveryState: 'sent', duplicate: false })
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
    expect(db.get('SELECT delivery_state FROM leads').delivery_state).toBe('sent')
    expect(send).toHaveBeenCalledOnce()
  })

  it('deduplicates a repeated idempotency key', async () => {
    const headers = { 'idempotency-key': '22222222-2222-4222-8222-222222222222' }
    const first = resFor()
    const second = resFor()
    await handler(reqFor({ headers }), first)
    await handler(reqFor({ headers, requestId: 'integration-request-0002' }), second)
    expect(second.payload).toMatchObject({ ok: true, duplicate: true })
    expect(counts()).toEqual({ leads: 1, attempts: 1 })
    expect(send).toHaveBeenCalledOnce()
  })
})
