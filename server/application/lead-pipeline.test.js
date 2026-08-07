import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { LEAD_BODY_MAX_BYTES, createLeadHandler } from './lead-pipeline.js'

const KEY = '11111111-1111-4111-8111-111111111111'

const validBody = {
  name: 'Test User',
  phone: '+998 90 000 00 00',
  message: 'Test lead, ignore',
  locale: 'en',
  pagePath: '/',
}

const config = {
  telegramBotToken: 'fixture-token',
  telegramChatId: 'fixture-chat',
  telegramApiBase: 'https://telegram.invalid',
  telegramEnabled: true,
  allowedOrigins: ['https://prohvac.test'],
  rateMax: 5,
  rateWindowMs: 60_000,
  requireMessage: false,
}

const request = (overrides = {}) => ({
  method: 'POST',
  body: overrides.body ?? validBody,
  socket: { remoteAddress: '203.0.113.10' },
  ...overrides,
  headers: {
    origin: 'https://prohvac.test',
    'content-type': 'application/json',
    ...(overrides.headers || {}),
  },
})

const response = () => {
  const headers = new Map()
  return {
    statusCode: 200,
    body: null,
    ended: false,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value))
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase())
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(value) {
      this.body = value
      this.ended = true
      return this
    },
    end() {
      this.ended = true
      return this
    },
  }
}

const setup = (overrides = {}) => {
  const submitLead = overrides.submitLead || vi.fn(async () => ({ ok: true, state: 'sent' }))
  const rateLimiter =
    overrides.rateLimiter || { hit: vi.fn(() => ({ allowed: true, retryAfterSec: 60 })) }
  const readBody =
    overrides.readBody ||
    vi.fn(async (req) => {
      const bytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8')
      return bytes > LEAD_BODY_MAX_BYTES
        ? { ok: false, error: 'payload_too_large' }
        : { ok: true, value: req.body }
    })
  const handler = createLeadHandler({
    getConfig: () => ({ ...config, ...(overrides.config || {}) }),
    getRequestContext: () => ({
      requestId: 'request-0001',
      clientIp: '203.0.113.10',
      ipHash: 'a'.repeat(64),
      userAgentHash: 'b'.repeat(64),
      timestamp: 1_700_000_000_000,
    }),
    rateLimiter,
    readBody,
    submitLead,
    buildMessage: () => 'fixture-message',
  })
  return { handler, submitLead, rateLimiter, readBody }
}

describe('lead intake ordering and data minimization', () => {
  it('rejects a wrong method before rate, parsing, or persistence', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
    expect(deps.rateLimiter.hit).not.toHaveBeenCalled()
    expect(deps.readBody).not.toHaveBeenCalled()
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  it('rejects a forbidden Origin before rate, parsing, or persistence', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(request({ headers: { origin: 'https://evil.test' } }), res)
    expect(res.statusCode).toBe(403)
    expect(deps.rateLimiter.hit).not.toHaveBeenCalled()
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  // CR-036. Раньше здесь проверялся envDeps.getConfig() — конфигурация
  // второго production-рантайма из process.env. Рантайм удалён вместе
  // с vercel.json, поэтому проверяем обратное: конвейер обязан получить
  // зависимости снаружи и не имеет собственного «окружённого» варианта.
  it('has no environment-backed runtime of its own', async () => {
    const module = await import('./lead-pipeline.js')
    expect(module.default).toBeUndefined()
    expect(module.envDeps).toBeUndefined()
  })

  it('refuses to build a handler with a missing dependency', () => {
    expect(() => createLeadHandler({})).toThrow(/getConfig/)
    expect(() => createLeadHandler({ getConfig: () => ({}) })).toThrow(/rateLimiter/)
  })

  it('permits the primary origin and configured extras through one CORS policy', async () => {
    const allowedOrigins = ['https://main.example', 'https://extra.example']
    const deps = setup({ config: { allowedOrigins } })

    for (const origin of allowedOrigins) {
      const res = response()
      await deps.handler(request({ method: 'OPTIONS', headers: { origin } }), res)
      expect(res.statusCode).toBe(204)
      expect(res.getHeader('access-control-allow-origin')).toBe(origin)
    }
    expect(deps.readBody).not.toHaveBeenCalled()
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  it('rejects a wrong content type before rate or parsing', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(request({ headers: { 'content-type': 'text/plain' } }), res)
    expect(res.statusCode).toBe(415)
    expect(deps.rateLimiter.hit).not.toHaveBeenCalled()
    expect(deps.readBody).not.toHaveBeenCalled()
  })

  it('rejects a declared oversized body before rate or parsing', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(
      request({ headers: { 'content-length': String(LEAD_BODY_MAX_BYTES + 1) } }),
      res
    )
    expect(res.statusCode).toBe(413)
    expect(deps.rateLimiter.hit).not.toHaveBeenCalled()
    expect(deps.readBody).not.toHaveBeenCalled()
  })

  it('rate limits before parsing or persistence', async () => {
    const deps = setup({ rateLimiter: { hit: vi.fn(() => ({ allowed: false, retryAfterSec: 7 })) } })
    const res = response()
    await deps.handler(request(), res)
    expect(res.statusCode).toBe(429)
    expect(res.getHeader('retry-after')).toBe('7')
    expect(deps.readBody).not.toHaveBeenCalled()
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  it('checks the actual pre-parsed body size after rate limiting', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(request({ body: { ...validBody, message: 'x'.repeat(LEAD_BODY_MAX_BYTES) } }), res)
    expect(res.statusCode).toBe(413)
    expect(deps.rateLimiter.hit).toHaveBeenCalledOnce()
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  it('validates before checking Telegram readiness', async () => {
    const deps = setup({
      config: { telegramBotToken: '', telegramChatId: '' },
    })
    const invalid = response()
    await deps.handler(request({ body: { ...validBody, phone: '+7 900 000 00 00' } }), invalid)
    expect(invalid.statusCode).toBe(400)
    expect(invalid.body.error).toBe('invalid_phone')

    const missing = response()
    await deps.handler(request(), missing)
    expect(missing.statusCode).toBe(503)
    expect(missing.body.error).toBe('not_configured')
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  it('submits exactly once after all checks and passes canonical metadata', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(request({ headers: { 'idempotency-key': KEY } }), res)
    expect(res.statusCode).toBe(200)
    expect(deps.submitLead).toHaveBeenCalledOnce()
    expect(deps.submitLead.mock.calls[0][0]).toMatchObject({
      lead: { name: 'Test User', phone: '+998900000000', message: 'Test lead, ignore' },
      idempotencyKey: KEY,
      metadata: { locale: 'en', pagePath: '/' },
    })
  })

  it('passes the same idempotency key on a repeated request', async () => {
    const seen = new Set()
    const submitLead = vi.fn(async ({ idempotencyKey }) => {
      const duplicate = seen.has(idempotencyKey)
      seen.add(idempotencyKey)
      return { ok: true, state: 'sent', duplicate }
    })
    const deps = setup({ submitLead })
    const headers = { 'idempotency-key': KEY }
    const first = response()
    const second = response()
    await deps.handler(request({ headers }), first)
    await deps.handler(request({ headers }), second)
    expect(first.body.duplicate).toBe(false)
    expect(second.body.duplicate).toBe(true)
    expect(submitLead).toHaveBeenCalledTimes(2)
  })
})

describe('idempotency key admission (CR-033)', () => {
  // Ключи прежнего формата: их принимало правило [A-Za-z0-9._:-]{8,128},
  // и подобрать такой ключ, чтобы получить состояние чужой отправки,
  // мог кто угодно.
  const guessable = [
    'lead-request-0001',
    'integration-lead-01',
    '12345678',
    'legacy:1',
    'a'.repeat(128),
  ]

  it.each(guessable)('rejects the guessable key %s before persistence', async (value) => {
    const deps = setup()
    const res = response()
    await deps.handler(request({ headers: { 'idempotency-key': value } }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: 'invalid_idempotency_key' })
    expect(deps.submitLead).not.toHaveBeenCalled()
  })

  it('rejects a repeated header and a non-v4 UUID', async () => {
    for (const value of [
      [KEY, KEY],
      '11111111-1111-1111-8111-111111111111',
      '11111111-1111-4111-c111-111111111111',
      `${KEY} `.repeat(2),
    ]) {
      const deps = setup()
      const res = response()
      await deps.handler(request({ headers: { 'idempotency-key': value } }), res)
      expect(res.statusCode).toBe(400)
      expect(deps.submitLead).not.toHaveBeenCalled()
    }
  })

  // Ключи, которые формирует сам сервер (requestId, randomUUID для повтора
  // из админки), обязаны проходить — иначе ужесточение ломает собственный код.
  it('accepts a server-issued key and normalizes its case', async () => {
    const deps = setup()
    const res = response()
    const issued = randomUUID()
    await deps.handler(
      request({ headers: { 'idempotency-key': ` ${issued.toUpperCase()} ` } }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(deps.submitLead.mock.calls[0][0].idempotencyKey).toBe(issued)
  })

  it('falls back to a server-generated key when the header is absent', async () => {
    const deps = setup()
    const res = response()
    await deps.handler(request(), res)
    expect(res.statusCode).toBe(200)
    expect(deps.submitLead.mock.calls[0][0].idempotencyKey).toBe('request-0001')
  })

  it('answers 409 idempotency_conflict when the key belongs to another lead', async () => {
    const conflict = Object.assign(new Error('idempotency_conflict'), {
      code: 'idempotency_conflict',
    })
    const deps = setup({
      submitLead: vi.fn(async () => {
        throw conflict
      }),
    })
    const res = response()
    await deps.handler(request({ headers: { 'idempotency-key': KEY } }), res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ ok: false, error: 'idempotency_conflict' })
  })

  it('does not swallow unrelated persistence failures', async () => {
    const deps = setup({
      submitLead: vi.fn(async () => {
        throw new Error('disk full')
      }),
    })
    await expect(deps.handler(request(), response())).rejects.toThrow('disk full')
  })

  it('never returns external identifiers to the public client', async () => {
    const deps = setup({
      submitLead: vi.fn(async () => ({
        ok: true,
        state: 'sent',
        duplicate: true,
        messageId: 424242,
        telegramMessageId: 424242,
      })),
    })
    const res = response()
    await deps.handler(request({ headers: { 'idempotency-key': KEY } }), res)

    expect(Object.keys(res.body).sort()).toEqual(['deliveryState', 'duplicate', 'ok'])
    expect(JSON.stringify(res.body)).not.toContain('424242')
  })
})
