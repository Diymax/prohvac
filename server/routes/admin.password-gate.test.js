// Серверная граница для учётки с временным паролем.
//
// Здесь намеренно используются настоящие route handlers и временная SQLite:
// UI-гейт не участвует, а значит тест ловит именно обход прямым HTTP-запросом.

import { Readable } from 'node:stream'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { hashPassword } from '../auth/password.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { config } from '../config.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createRouter } from '../router.js'
import { registerAdmin2faRoutes } from './admin.2fa.js'
import { registerAdminAuthRoutes } from './admin.auth.js'
import { registerAdminContentRoutes } from './admin.content.js'
import { registerAdminLeadsRoutes } from './admin.leads.js'
import { registerAdminMediaRoutes } from './admin.media.js'

let available = true
let unavailable = ''
try {
  createSqliteDriver(':memory:').close()
} catch (error) {
  available = false
  unavailable = error.message
}

const describeDb = available ? describe : describe.skip
const suiteName = available
  ? 'admin password-change gate'
  : `admin password-change gate — пропущено: node:sqlite недоступен (${unavailable})`

const CURRENT_PASSWORD = 'Temporary-Mango-47!'
const NEXT_PASSWORD = 'Severniy-Veter-7391!'
const CLIENT_IP = '203.0.113.17'
const CLIENT_UA = 'password-gate-test'

let currentPasswordHash = ''
beforeAll(async () => {
  if (available) currentPasswordHash = await hashPassword(CURRENT_PASSWORD)
})

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

const fakeReq = ({
  method,
  url,
  token,
  csrfToken = '',
  body,
  contentType = body === undefined ? '' : 'application/json',
}) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = {
    origin: config.publicOrigin,
    'user-agent': CLIENT_UA,
    'x-real-ip': CLIENT_IP,
    ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    ...(contentType ? { 'content-type': contentType } : {}),
  }
  req.socket = { remoteAddress: CLIENT_IP }
  return req
}

const invoke = async (router, request) => {
  const matched = router.match(request.method, request.url)
  if (!matched?.handler) throw new Error(`test route not found: ${request.method} ${request.url}`)

  const response = fakeRes()
  await matched.handler(request, response, matched.params)
  return {
    response,
    payload: response.body ? JSON.parse(response.body) : null,
  }
}

const allowingThrottle = () => ({
  hit: vi.fn(() => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
  reset: vi.fn(),
})

const setup = async ({
  role = 'owner',
  mustChangePassword = true,
  sessionState = 'active',
} = {}) => {
  const db = createSqliteDriver(':memory:')
  runMigrations(db)

  const inserted = db.run(
    `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
     VALUES (?, ?, ?, ?, 0)`,
    ['gate-user', currentPasswordHash, role, mustChangePassword ? 1 : 0]
  )
  const userId = Number(inserted.lastInsertRowid)
  const created = createSession(db, {
    userId,
    state: sessionState,
    ip: CLIENT_IP,
    ua: CLIENT_UA,
    amr: 'pwd',
  })

  const router = createRouter()
  const throttle = allowingThrottle()
  registerAdmin2faRoutes(router, { db })
  registerAdminAuthRoutes(router, {
    db,
    throttle,
    escalation: { registerFailure: vi.fn(() => ({ blocked: false, delayMs: 0 })) },
  })
  registerAdminContentRoutes(router, {
    db,
    enqueueTranslation: vi.fn(),
    translateStatus: () => ({ queued: 0, running: 0, failed: 0 }),
  })
  registerAdminLeadsRoutes(router, { db })
  registerAdminMediaRoutes(router, { db })

  return {
    db,
    router,
    userId,
    token: created.token,
    csrfToken: created.csrfToken,
  }
}

const expectPasswordGate = ({ response, payload }) => {
  expect(response.statusCode).toBe(403)
  expect(payload).toEqual({ ok: false, error: 'must_change_password' })
}

describeDb(suiteName, () => {
  it('сохраняет 404-маскировку для анонимного admin API', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({ method: 'GET', url: '/api/admin/leads' })
    )

    expect(result.response.statusCode).toBe(404)
    expect(result.payload).toEqual({ ok: false, error: 'not_found' })
    ctx.db.close()
  })

  it('временный пароль не позволяет читать заявки', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({ method: 'GET', url: '/api/admin/leads', token: ctx.token })
    )

    expectPasswordGate(result)
    ctx.db.close()
  })

  it('временный пароль не позволяет изменять контент', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({
        method: 'PUT',
        url: '/api/admin/content/hero.title',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
        body: { lang: 'ru', value: 'Новый заголовок' },
      })
    )

    expectPasswordGate(result)
    ctx.db.close()
  })

  it('временный пароль не позволяет загружать медиа', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({
        method: 'POST',
        url: '/api/admin/media',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
        contentType: 'multipart/form-data; boundary=test',
      })
    )

    expectPasswordGate(result)
    ctx.db.close()
  })

  it('разрешает минимальную информацию о сессии до смены пароля', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({ method: 'GET', url: '/api/admin/session', token: ctx.token })
    )

    expect(result.response.statusCode).toBe(200)
    expect(result.payload).toMatchObject({
      ok: true,
      user: 'gate-user',
      mustChangePassword: true,
    })
    ctx.db.close()
  })

  it('разрешает завершить сессию до смены пароля', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({
        method: 'DELETE',
        url: '/api/admin/session',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
      })
    )

    expect(result.response.statusCode).toBe(200)
    expect(result.payload).toEqual({ ok: true })
    ctx.db.close()
  })

  it('оставляет setup и confirm доступными только для незавершённого enrollment', async () => {
    const ctx = await setup({ sessionState: 'pending_totp' })
    const setupResult = await invoke(
      ctx.router,
      fakeReq({
        method: 'POST',
        url: '/api/admin/2fa/setup',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
        body: {},
      })
    )

    expect(setupResult.response.statusCode).toBe(200)
    expect(setupResult.payload).toMatchObject({ ok: true, rebind: false })

    // Пустой код доходит до прикладной проверки confirm и получает bad_totp,
    // а не password gate: это доказывает доступность необходимого шага flow.
    const confirmResult = await invoke(
      ctx.router,
      fakeReq({
        method: 'POST',
        url: '/api/admin/2fa/confirm',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
        body: { code: '' },
      })
    )
    expect(confirmResult.response.statusCode).toBe(400)
    expect(confirmResult.payload).toMatchObject({ ok: false, error: 'bad_totp' })

    ctx.db.close()
  })

  it('не позволяет перевыпускать recovery-коды до смены пароля', async () => {
    const ctx = await setup()
    const result = await invoke(
      ctx.router,
      fakeReq({
        method: 'POST',
        url: '/api/admin/2fa/recovery-codes',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
        body: {},
      })
    )

    expectPasswordGate(result)
    ctx.db.close()
  })

  it('не позволяет владельцу с временным паролем удалить чужой 2FA', async () => {
    const ctx = await setup()
    const target = ctx.db.run(
      `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
       VALUES (?, ?, 'viewer', 0, 1)`,
      ['target-user', currentPasswordHash]
    )
    const result = await invoke(
      ctx.router,
      fakeReq({
        method: 'DELETE',
        url: `/api/admin/2fa/${target.lastInsertRowid}`,
        token: ctx.token,
        csrfToken: ctx.csrfToken,
      })
    )

    expectPasswordGate(result)
    ctx.db.close()
  })

  it('после смены пароля открывает чтение, но сохраняет ограничения роли', async () => {
    const ctx = await setup({ role: 'viewer' })
    const changed = await invoke(
      ctx.router,
      fakeReq({
        method: 'POST',
        url: '/api/admin/password',
        token: ctx.token,
        csrfToken: ctx.csrfToken,
        body: { current: CURRENT_PASSWORD, next: NEXT_PASSWORD },
      })
    )

    expect(changed.response.statusCode).toBe(200)
    expect(changed.payload.mustChangePassword).toBe(false)
    expect(changed.payload.capabilities).toMatchObject({
      'content.read': true,
      'content.write': false,
      'media.read': true,
      'media.upload': false,
      'leads.read': true,
      'leads.export': false,
      'settings.manage': false,
    })

    const cookie = String(changed.response.headers['set-cookie'])
    const nextToken = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
    expect(nextToken).toBeTruthy()

    const leads = await invoke(
      ctx.router,
      fakeReq({ method: 'GET', url: '/api/admin/leads', token: nextToken })
    )
    expect(leads.response.statusCode).toBe(200)
    expect(leads.payload).toMatchObject({ ok: true, total: 0 })

    ctx.db.run(
      `INSERT INTO settings (key, value, is_secret, updated_at)
       VALUES ('media.quota_bytes', ?, 0, ?)`,
      [String(8 * 1024 * 1024), Date.now()]
    )
    const media = await invoke(
      ctx.router,
      fakeReq({ method: 'GET', url: '/api/admin/media', token: nextToken })
    )
    expect(media.response.statusCode).toBe(200)
    expect(media.payload.capabilities).toMatchObject({
      maxBytes: 400 * 1024,
      maxDimension: 1920,
      allowedMimeTypes: ['image/webp', 'image/avif', 'image/jpeg', 'image/png'],
      remainingQuotaBytes: 8 * 1024 * 1024,
    })

    const denied = await invoke(
      ctx.router,
      fakeReq({
        method: 'PUT',
        url: '/api/admin/content/hero.title',
        token: nextToken,
        csrfToken: changed.payload.csrfToken,
        body: { lang: 'ru', value: 'Viewer не должен сохранить это' },
      })
    )
    expect(denied.response.statusCode).toBe(403)
    expect(denied.payload).toEqual({ ok: false, error: 'forbidden' })

    ctx.db.close()
  })
})
