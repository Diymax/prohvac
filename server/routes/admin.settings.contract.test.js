// The settings write path seen from outside: what the admin saves is what the
// runtime reads, and the secret it saves never comes back out.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SETTING_KEYS } from '../../shared/settings.js'
import { resolveTelegramConfig } from '../application/telegram-config.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { config } from '../config.js'
import { createSqliteDriver } from '../db/driver.js'
import { createRouter } from '../router.js'
import { registerAdminSettingsRoutes } from './admin.settings.js'
import { resolveLeadRuntimeConfig } from './public.lead.js'

const SCHEMA = readFileSync(
  join(import.meta.dirname, '..', 'db', 'migrations', '001_init.sql'),
  'utf8'
).replace(/^\uFEFF/, '')

const CLIENT_IP = '203.0.113.77'
const CLIENT_UA = 'settings-contract-test'

// Obviously fake credentials: the token shape only has to satisfy the schema.
// Маркер NOT-A-REAL-TOKEN обязателен: фикстура повторяет форму боевого
// токена Telegram, и сканер секретов в scripts/secret-patterns.mjs иначе
// не пустил бы файл в source handoff.
const BOT_TOKEN = '1234567890:NOT-A-REAL-TOKEN-CONTRACT-FIXTURE-01'
const CHAT_ID = '-1001234567890'
const TEMPLATE = 'contract template {name} {phone}'

const fakeRes = () => ({
  statusCode: 200,
  headersSent: false,
  writableEnded: false,
  headers: {},
  body: '',
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  },
  getHeader(name) {
    return this.headers[name.toLowerCase()]
  },
  removeHeader(name) {
    delete this.headers[name.toLowerCase()]
  },
  end(chunk) {
    this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    this.writableEnded = true
  },
})

const fakeReq = ({ method, url, token, csrfToken = '', body }) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = {
    origin: config.publicOrigin,
    'user-agent': CLIENT_UA,
    'x-real-ip': CLIENT_IP,
    cookie: `${SESSION_COOKIE}=${token}`,
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }
  req.socket = { remoteAddress: CLIENT_IP }
  return req
}

describe('admin settings write path', () => {
  let db
  let invoke

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec(SCHEMA)
    const inserted = db.run(
      `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
       VALUES ('contract-owner', 'test-only-hash', 'owner', 0, 0)`
    )
    const session = createSession(db, {
      userId: Number(inserted.lastInsertRowid),
      state: 'active',
      ip: CLIENT_IP,
      ua: CLIENT_UA,
    })
    const router = createRouter()
    registerAdminSettingsRoutes(router, { db })

    invoke = async ({ method, body }) => {
      const url = '/api/admin/settings'
      const matched = router.match(method, url)
      const response = fakeRes()
      await matched.handler(
        fakeReq({ method, url, token: session.token, csrfToken: session.csrfToken, body }),
        response,
        matched.params
      )
      return { response, payload: response.body ? JSON.parse(response.body) : null }
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  const put = async (key, value) => {
    const saved = await invoke({ method: 'PUT', body: { key, value } })
    expect(saved.response.statusCode).toBe(200)
    return saved
  }

  it('hands the runtime exactly the Telegram configuration that was saved', async () => {
    await put(SETTING_KEYS.TELEGRAM_BOT_TOKEN, BOT_TOKEN)
    await put(SETTING_KEYS.TELEGRAM_CHAT_ID, CHAT_ID)
    await put(SETTING_KEYS.TELEGRAM_TEMPLATE, TEMPLATE)
    await put(SETTING_KEYS.TELEGRAM_ENABLED, false)

    expect(resolveTelegramConfig(db)).toMatchObject({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      template: TEMPLATE,
      enabled: false,
    })

    expect(resolveLeadRuntimeConfig(db)).toMatchObject({
      telegramBotToken: BOT_TOKEN,
      telegramChatId: CHAT_ID,
      template: TEMPLATE,
      telegramEnabled: false,
    })
  })

  it('picks up a changed setting on the next read', async () => {
    await put(SETTING_KEYS.TELEGRAM_TEMPLATE, TEMPLATE)
    expect(resolveTelegramConfig(db).template).toBe(TEMPLATE)

    await put(SETTING_KEYS.TELEGRAM_TEMPLATE, 'second template {name}')
    expect(resolveTelegramConfig(db).template).toBe('second template {name}')
  })

  it('never returns the stored secret to the client', async () => {
    const saved = await put(SETTING_KEYS.TELEGRAM_BOT_TOKEN, BOT_TOKEN)
    expect(saved.payload).toMatchObject({ isSecret: true, isSet: true })
    expect(saved.response.body).not.toContain(BOT_TOKEN)

    const listed = await invoke({ method: 'GET' })
    expect(listed.response.statusCode).toBe(200)
    expect(listed.response.body).not.toContain(BOT_TOKEN)

    const item = listed.payload.items.find(
      (candidate) => candidate.key === SETTING_KEYS.TELEGRAM_BOT_TOKEN
    )
    expect(item).toMatchObject({ isSecret: true, isSet: true })
    expect(item.value).toBeUndefined()

    // The audit trail is exported and read from the panel, so it must not
    // carry the value either.
    const diffs = db
      .all(`SELECT diff FROM audit_log WHERE entity = 'settings'`)
      .map((row) => row.diff ?? '')
      .join(' ')
    expect(diffs).not.toContain(BOT_TOKEN)
    expect(diffs).toContain('"secret":true')

    // Only the server code that is about to use it may see the plaintext.
    expect(resolveTelegramConfig(db).botToken).toBe(BOT_TOKEN)
  })
})
