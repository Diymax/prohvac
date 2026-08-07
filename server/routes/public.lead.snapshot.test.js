// One lead is processed against one configuration.
//
// The pipeline asks for the configuration before it reads the request body and
// renders the message after it, so a settings change that lands in between used
// to produce a mixed configuration: the old bot with the new template, or the
// new rate limit with the old chat id.

import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachResponseHelpers } from '../../shared/http-compat.js'
import { SETTING_KEYS } from '../../shared/settings.js'
import { createSettingsService } from '../application/settings-service.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createProdLeadHandler, resolveLeadRuntimeConfig } from './public.lead.js'

// Маркер NOT-A-REAL-TOKEN обязателен: фикстура повторяет форму боевого
// токена Telegram, и сканер секретов в scripts/secret-patterns.mjs иначе
// не пустил бы файл в source handoff.
const FIRST_TOKEN = '1234567890:NOT-A-REAL-TOKEN-SNAPSHOT-FIXTURE-1'
const SECOND_TOKEN = '1234567890:NOT-A-REAL-TOKEN-SNAPSHOT-FIXTURE-2'
const FIRST_TEMPLATE = 'FIRST {name}'
const SECOND_TEMPLATE = 'SECOND {name}'

const lead = {
  name: 'Test User',
  phone: '+998 90 000 00 00',
  message: 'Test lead, ignore',
  locale: 'en',
  pagePath: '/',
}

const resFor = () => {
  const headers = new Map()
  return attachResponseHelpers({
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
  })
}

describe('lead runtime configuration snapshot', () => {
  let db
  let settings
  let send

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
    settings = createSettingsService(db)
    send = vi.fn(async () => ({ ok: true, definitive: true, responseCode: 200, messageId: 77 }))

    for (const [key, value] of [
      [SETTING_KEYS.TELEGRAM_BOT_TOKEN, FIRST_TOKEN],
      [SETTING_KEYS.TELEGRAM_CHAT_ID, '-1001111111111'],
      [SETTING_KEYS.TELEGRAM_TEMPLATE, FIRST_TEMPLATE],
    ]) {
      const checked = settings.validate(key, value)
      expect(checked.ok).toBe(true)
      settings.write(key, checked)
    }
  })

  afterEach(() => db.close())

  const save = (key, value) => {
    const checked = settings.validate(key, value)
    expect(checked.ok).toBe(true)
    settings.write(key, checked)
  }

  /**
   * A request whose body arrives only after `onRead` has run. That is exactly
   * the window between "configuration taken" and "message rendered".
   */
  const reqFor = (onRead) => {
    const raw = JSON.stringify(lead)
    const req = Readable.from(
      (async function* body() {
        onRead()
        yield Buffer.from(raw)
      })()
    )
    req.method = 'POST'
    req.url = '/api/lead'
    req.headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(raw)),
      'idempotency-key': '33333333-3333-4333-8333-333333333333',
    }
    req.socket = { remoteAddress: '203.0.113.44' }
    req.context = Object.freeze({
      requestId: 'snapshot-request-0001',
      clientIp: '203.0.113.44',
      ipHash: 'c'.repeat(64),
      userAgent: 'lead-snapshot-test',
      userAgentHash: 'd'.repeat(64),
      origin: null,
      timestamp: 1_700_000_000_000,
    })
    return req
  }

  it('keeps the configuration a request started with when settings change mid-flight', async () => {
    const handler = createProdLeadHandler({
      db,
      telegramGateway: { send },
      rateLimiter: { hit: () => ({ allowed: true, resetAt: Date.now() + 60_000 }) },
    })

    const res = resFor()
    await handler(
      reqFor(() => {
        save(SETTING_KEYS.TELEGRAM_TEMPLATE, SECOND_TEMPLATE)
        save(SETTING_KEYS.TELEGRAM_BOT_TOKEN, SECOND_TOKEN)
      }),
      res
    )

    expect(res.statusCode).toBe(200)
    expect(send).toHaveBeenCalledOnce()

    const [delivered] = send.mock.calls[0]
    expect(delivered.botToken).toBe(FIRST_TOKEN)
    expect(delivered.text.startsWith('FIRST')).toBe(true)
    expect(delivered.text).not.toContain('SECOND')

    // The change did land - it simply belongs to the next request.
    expect(resolveLeadRuntimeConfig(db)).toMatchObject({
      template: SECOND_TEMPLATE,
      telegramBotToken: SECOND_TOKEN,
    })
  })

  it('reads the configuration once per request', async () => {
    const getConfig = vi.fn(() => resolveLeadRuntimeConfig(db))
    const handler = createProdLeadHandler({
      db,
      telegramGateway: { send },
      rateLimiter: { hit: () => ({ allowed: true, resetAt: Date.now() + 60_000 }) },
      getConfig,
    })

    await handler(reqFor(() => {}), resFor())
    expect(getConfig).toHaveBeenCalledTimes(1)

    await handler(reqFor(() => {}), resFor())
    expect(getConfig).toHaveBeenCalledTimes(2)
  })

  it('gives overlapping requests their own snapshot', async () => {
    const handler = createProdLeadHandler({
      db,
      telegramGateway: { send },
      rateLimiter: { hit: () => ({ allowed: true, resetAt: Date.now() + 60_000 }) },
    })

    const first = reqFor(() => {})
    first.headers['idempotency-key'] = '44444444-4444-4444-8444-444444444444'
    const second = reqFor(() => {})
    second.headers['idempotency-key'] = '55555555-5555-4555-8555-555555555555'

    // The first request takes its snapshot synchronously and then suspends on
    // the request body; the change and the second request happen while it is
    // still in flight.
    const firstDone = handler(first, resFor())
    save(SETTING_KEYS.TELEGRAM_TEMPLATE, SECOND_TEMPLATE)
    const secondDone = handler(second, resFor())
    await Promise.all([firstDone, secondDone])

    expect(send).toHaveBeenCalledTimes(2)
    const [firstText, secondText] = send.mock.calls.map(([call]) => call.text)
    expect(firstText.startsWith('FIRST')).toBe(true)
    expect(secondText.startsWith('SECOND')).toBe(true)
  })
})
