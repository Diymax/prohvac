import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SETTING_KEYS } from '../../shared/settings.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { config } from '../config.js'
import { createSqliteDriver } from '../db/driver.js'
import { createRouter } from '../router.js'
import { createDeepLProvider } from '../translate/providers/deepl.js'
import { resolveMediaQuota } from './admin.media.js'
import { readSetting, registerAdminSettingsRoutes } from './admin.settings.js'
import { resolveLeadRuntimeConfig } from './public.lead.js'

let sqliteAvailable = true
try {
  createSqliteDriver(':memory:').close()
} catch {
  sqliteAvailable = false
}

const describeDb = sqliteAvailable ? describe : describe.skip
const SCHEMA = readFileSync(
  join(import.meta.dirname, '..', 'db', 'migrations', '001_init.sql'),
  'utf8'
).replace(/^\uFEFF/, '')

const CLIENT_IP = '203.0.113.31'
const CLIENT_UA = 'settings-registry-test'

const fakeRes = () => ({
  statusCode: 200,
  headersSent: false,
  writableEnded: false,
  headers: {},
  body: '',
  setHeader (name, value) {
    this.headers[name.toLowerCase()] = value
  },
  getHeader (name) {
    return this.headers[name.toLowerCase()]
  },
  removeHeader (name) {
    delete this.headers[name.toLowerCase()]
  },
  end (chunk) {
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

const setup = () => {
  const db = createSqliteDriver(':memory:')
  db.exec(SCHEMA)
  const inserted = db.run(
    `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
     VALUES ('settings-owner', 'test-only-hash', 'owner', 0, 0)`
  )
  const session = createSession(db, {
    userId: Number(inserted.lastInsertRowid),
    state: 'active',
    ip: CLIENT_IP,
    ua: CLIENT_UA,
  })
  const router = createRouter()
  registerAdminSettingsRoutes(router, { db })

  const invoke = async ({ method, body }) => {
    const url = '/api/admin/settings'
    const matched = router.match(method, url)
    const response = fakeRes()
    await matched.handler(
      fakeReq({
        method,
        url,
        token: session.token,
        csrfToken: session.csrfToken,
        body,
      }),
      response,
      matched.params
    )
    return {
      response,
      payload: response.body ? JSON.parse(response.body) : null,
    }
  }

  return { db, invoke }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describeDb('admin settings registry and encrypted secrets', () => {
  it('writes the canonical DeepL key and the provider consumes it without disclosure', async () => {
    const { db, invoke } = setup()
    const storedValue = 'unit-deepl-value-a'
    const fallbackValue = 'unit-deepl-fallback'

    const saved = await invoke({
      method: 'PUT',
      body: { key: SETTING_KEYS.DEEPL_API_KEY, value: storedValue },
    })
    expect(saved.response.statusCode).toBe(200)
    expect(saved.payload).toMatchObject({
      ok: true,
      key: SETTING_KEYS.DEEPL_API_KEY,
      isSecret: true,
      isSet: true,
    })
    expect(saved.response.body).not.toContain(storedValue)

    const row = db.get('SELECT * FROM settings WHERE key = ?', [SETTING_KEYS.DEEPL_API_KEY])
    expect(row.value).toBeNull()
    expect(row.value_ct).toBeInstanceOf(Uint8Array)
    expect(row.value_iv.byteLength).toBe(12)
    expect(row.value_tag.byteLength).toBe(16)

    const request = vi.fn(async () =>
      new Response(JSON.stringify({ character_count: 12, character_limit: 100 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', request)
    const provider = createDeepLProvider({
      db,
      envApiKey: fallbackValue,
      base: 'https://deepl.invalid',
    })

    await expect(provider.usage()).resolves.toEqual({ used: 12, limit: 100 })
    const [, options] = request.mock.calls[0]
    expect(options.headers.Authorization).toBe(`DeepL-Auth-Key ${storedValue}`)
    expect(options.headers.Authorization).not.toContain(fallbackValue)

    const listed = await invoke({ method: 'GET' })
    const item = listed.payload.items.find((candidate) => candidate.key === SETTING_KEYS.DEEPL_API_KEY)
    expect(item).toMatchObject({ isSecret: true, isSet: true })
    expect(JSON.stringify(item)).not.toContain(storedValue)
    db.close()
  })

  it('supports secret update and deletion, then uses the documented env fallback', async () => {
    const { db, invoke } = setup()

    await invoke({
      method: 'PUT',
      body: { key: SETTING_KEYS.DEEPL_API_KEY, value: 'unit-deepl-value-a' },
    })
    await invoke({
      method: 'PUT',
      body: { key: SETTING_KEYS.DEEPL_API_KEY, value: 'unit-deepl-value-b' },
    })
    expect(createDeepLProvider({ db, envApiKey: '' }).isConfigured()).toBe(true)

    const removed = await invoke({
      method: 'PUT',
      body: { key: SETTING_KEYS.DEEPL_API_KEY, value: '' },
    })
    expect(removed.payload).toMatchObject({ ok: true, isSecret: true, isSet: false })
    expect(
      db.get('SELECT key FROM settings WHERE key = ?', [SETTING_KEYS.DEEPL_API_KEY])
    ).toBeUndefined()
    expect(createDeepLProvider({ db, envApiKey: 'unit-env-value' }).isConfigured()).toBe(true)
    expect(createDeepLProvider({ db, envApiKey: '' }).isConfigured()).toBe(false)
    db.close()
  })

  it('treats authenticated-ciphertext failure as corrupt and blocks env fallback', async () => {
    const { db, invoke } = setup()
    const plaintext = 'unit-deepl-corrupt-me'
    await invoke({
      method: 'PUT',
      body: { key: SETTING_KEYS.DEEPL_API_KEY, value: plaintext },
    })

    const row = db.get('SELECT value_ct FROM settings WHERE key = ?', [
      SETTING_KEYS.DEEPL_API_KEY,
    ])
    const corrupt = Buffer.from(row.value_ct)
    corrupt[0] ^= 0xff
    db.run('UPDATE settings SET value_ct = ? WHERE key = ?', [
      corrupt,
      SETTING_KEYS.DEEPL_API_KEY,
    ])

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const listed = await invoke({ method: 'GET' })
    const item = listed.payload.items.find((candidate) => candidate.key === SETTING_KEYS.DEEPL_API_KEY)
    expect(item).toMatchObject({ isSecret: true, isSet: false, preview: '' })
    expect(createDeepLProvider({ db, envApiKey: 'unit-env-value' }).isConfigured()).toBe(false)

    const warningText = warning.mock.calls.flat().join(' ')
    expect(warningText).toContain(`key=${SETTING_KEYS.DEEPL_API_KEY}`)
    expect(warningText).toContain('ciphertext_auth_failed')
    expect(warningText).not.toContain(plaintext)
    expect(JSON.stringify(listed.payload)).not.toContain(plaintext)
    db.close()
  })

  it('applies every retained operational setting to its runtime consumer', async () => {
    const { db, invoke } = setup()
    const values = [
      [SETTING_KEYS.LEAD_RATE_MAX, 17],
      [SETTING_KEYS.LEAD_RATE_WINDOW_MS, 45_000],
      [SETTING_KEYS.FORM_REQUIRE_MESSAGE, true],
      [SETTING_KEYS.MEDIA_QUOTA_BYTES, 8 * 1024 * 1024],
      [SETTING_KEYS.SEO_TITLE, 'Runtime SEO title'],
      [SETTING_KEYS.SEO_DESCRIPTION, 'Runtime SEO description'],
      [SETTING_KEYS.SEO_OG_IMAGE, 'https://cdn.example.test/og.webp'],
    ]

    for (const [key, value] of values) {
      const saved = await invoke({ method: 'PUT', body: { key, value } })
      expect(saved.response.statusCode).toBe(200)
    }

    expect(resolveLeadRuntimeConfig(db)).toMatchObject({
      rateMax: 17,
      rateWindowMs: 45_000,
      requireMessage: true,
    })
    expect(resolveMediaQuota(db)).toBe(8 * 1024 * 1024)
    expect(readSetting(db, SETTING_KEYS.SEO_TITLE)).toBe('Runtime SEO title')
    expect(readSetting(db, SETTING_KEYS.SEO_DESCRIPTION)).toBe('Runtime SEO description')
    expect(readSetting(db, SETTING_KEYS.SEO_OG_IMAGE)).toBe(
      'https://cdn.example.test/og.webp'
    )
    // form + the three SEO fields invalidate the public content response.
    expect(db.get(`SELECT value FROM app_state WHERE key = 'content_generation'`).value).toBe(
      '4'
    )
    db.close()
  })

  it('rejects operational settings outside registry bounds', async () => {
    const { db, invoke } = setup()
    for (const [key, value] of [
      [SETTING_KEYS.LEAD_RATE_MAX, 0],
      [SETTING_KEYS.LEAD_RATE_WINDOW_MS, 999],
      [SETTING_KEYS.MEDIA_QUOTA_BYTES, 1024],
    ]) {
      const saved = await invoke({ method: 'PUT', body: { key, value } })
      expect(saved.response.statusCode).toBe(400)
      expect(saved.payload.error).toBe('invalid_value')
    }
    db.close()
  })
})
