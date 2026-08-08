// Раздел «Пользователи». Проверяется то, из-за чего он и появился: кто вправе
// им пользоваться и какие действия обязаны быть запрещены, чтобы панель нельзя
// было оставить без единого владельца.

import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { config } from '../config.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createRouter } from '../router.js'
import { registerAdminUsersRoutes } from './admin.users.js'

let sqliteAvailable = true
try {
  createSqliteDriver(':memory:').close()
} catch {
  sqliteAvailable = false
}
const describeDb = sqliteAvailable ? describe : describe.skip

const CLIENT_IP = '203.0.113.44'
const CLIENT_UA = 'users-route-test'

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
    ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }
  req.socket = { remoteAddress: CLIENT_IP }
  return req
}

const insertUser = (db, username, role, status = 'active') =>
  Number(
    db.run(
      `INSERT INTO users (username, password_hash, role, status, must_change_password, totp_required)
       VALUES (?, 'test-only-hash', ?, ?, 0, 0)`,
      [username, role, status]
    ).lastInsertRowid
  )

const setup = ({ actorRole = 'owner' } = {}) => {
  const db = createSqliteDriver(':memory:')
  runMigrations(db)

  const actorId = insertUser(db, `actor-${actorRole}`, actorRole)
  const session = createSession(db, {
    userId: actorId,
    state: 'active',
    ip: CLIENT_IP,
    ua: CLIENT_UA,
  })

  const router = createRouter()
  registerAdminUsersRoutes(router, { db })

  const call = async (method, url, body, { csrf = true, token = session.token } = {}) => {
    const matched = router.match(method, url)
    if (!matched.handler) throw new Error(`маршрут не найден: ${method} ${url}`)
    const response = fakeRes()
    await matched.handler(
      fakeReq({
        method,
        url,
        token,
        csrfToken: csrf ? session.csrfToken : '',
        body,
      }),
      response,
      matched.params
    )
    return { status: response.statusCode, payload: response.body ? JSON.parse(response.body) : null }
  }

  return { db, call, actorId }
}

describeDb('admin users: доступ к разделу', () => {
  it('владелец видит список и себя в нём', async () => {
    const { call, actorId } = setup()
    const { status, payload } = await call('GET', '/api/admin/users')

    expect(status).toBe(200)
    expect(payload.self).toBe(actorId)
    expect(payload.users.map((user) => user.role)).toContain('owner')
    // Хеш пароля не должен покидать сервер ни под каким ключом.
    expect(JSON.stringify(payload)).not.toContain('test-only-hash')
  })

  it.each([['admin'], ['editor'], ['viewer']])('роль %s в раздел не пускают', async (role) => {
    const { call, db } = setup({ actorRole: role })
    const { status, payload } = await call('GET', '/api/admin/users')

    expect(status).toBe(403)
    expect(payload.error).toBe('forbidden')
    // Отказ виден в журнале: попытка управлять учётками — событие безопасности.
    expect(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'users.denied'").n).toBe(1)
  })

  it('без сессии раздел неотличим от несуществующего пути', async () => {
    const { call } = setup()
    const { status } = await call('GET', '/api/admin/users', undefined, { token: '' })
    expect(status).toBe(404)
  })

  it('изменение без CSRF-токена отклоняется', async () => {
    const { call } = setup()
    // Токен снимается намеренно: проверяется, что без него запрос не проходит.
    // sr:allow=SEC-CSRF-DISABLED — сканер видит здесь выключенную защиту,
    // а это её тест.
    const { status } = await call('POST', '/api/admin/users', { username: 'somebody', role: 'viewer' }, { csrf: false }) // sr:allow=SEC-CSRF-DISABLED
    expect(status).toBe(403)
  })
})

describeDb('admin users: создание', () => {
  it('заводит учётку с временным паролем и обязательным вторым фактором', async () => {
    const { call, db } = setup()
    const { status, payload } = await call('POST', '/api/admin/users', {
      username: 'novichok',
      role: 'editor',
    })

    expect(status).toBe(201)
    expect(payload.user).toMatchObject({ username: 'novichok', role: 'editor', status: 'active' })
    expect(payload.user.mustChangePassword).toBe(true)
    expect(payload.user.twoFactor).toBe('required')
    expect(payload.password).toHaveLength(24)

    // В базе только хеш, и он не равен выданному паролю.
    const row = db.get('SELECT password_hash FROM users WHERE username = ?', ['novichok'])
    expect(row.password_hash).not.toBe(payload.password)
    // Пароль не попадает в журнал: его выгружают в бэкап и читают из панели.
    const entries = db.all("SELECT diff FROM audit_log WHERE action = 'users.create'")
    expect(entries).toHaveLength(1)
    expect(entries[0].diff).not.toContain(payload.password)
  })

  it('не заводит двойника, отличающегося только регистром', async () => {
    const { call } = setup()
    await call('POST', '/api/admin/users', { username: 'petrov', role: 'viewer' })
    const { status, payload } = await call('POST', '/api/admin/users', { username: 'Petrov', role: 'viewer' })

    expect(status).toBe(409)
    expect(payload.error).toBe('username_taken')
  })

  it.each([
    ['ab', 'invalid_username'],
    ['имя-кириллицей', 'invalid_username'],
    ['with space', 'invalid_username'],
  ])('отклоняет логин "%s"', async (username, error) => {
    const { call } = setup()
    const { status, payload } = await call('POST', '/api/admin/users', { username, role: 'viewer' })
    expect(status).toBe(400)
    expect(payload.error).toBe(error)
  })

  it('отклоняет неизвестную роль', async () => {
    const { call } = setup()
    const { status, payload } = await call('POST', '/api/admin/users', { username: 'someone', role: 'root' })
    expect(status).toBe(400)
    expect(payload.error).toBe('unknown_role')
  })
})

describeDb('admin users: защита от потери доступа', () => {
  it('свою учётку этим разделом не меняют', async () => {
    const { call, actorId } = setup()

    for (const [method, url, body] of [
      ['PATCH', `/api/admin/users/${actorId}`, { role: 'viewer' }],
      ['PATCH', `/api/admin/users/${actorId}`, { status: 'disabled' }],
      ['POST', `/api/admin/users/${actorId}/reset-2fa`, {}],
      ['DELETE', `/api/admin/users/${actorId}`, undefined],
    ]) {
      const { status, payload } = await call(method, url, body)
      expect(status).toBe(409)
      expect(payload.error).toBe('self_target')
    }
  })

  // Правило «последнего владельца не трогать» проверяется на уровне домена
  // (server/application/user-admin.test.js): через HTTP до него не дойти,
  // потому что единственный кандидат — учётка самого действующего владельца,
  // а её раньше отсекает self_target. Здесь проверяем обратное — что второго
  // владельца понизить можно.
  it('второго владельца понизить можно', async () => {
    const { call, db } = setup()
    const second = insertUser(db, 'vtoroy-vladelec', 'owner')

    const { status, payload } = await call('PATCH', `/api/admin/users/${second}`, { role: 'admin' })
    expect(status).toBe(200)
    expect(payload.users.find((user) => user.id === second).role).toBe('admin')
  })

  it('отключённый владелец не считается действующим', async () => {
    const { call, db } = setup()
    const spare = insertUser(db, 'spare-owner', 'owner', 'disabled')
    // Владельцев формально двое, но действующий один — актор. Значит понизить
    // актора нельзя... а вот отключённого запасного можно тронуть свободно.
    const { status } = await call('PATCH', `/api/admin/users/${spare}`, { role: 'viewer' })
    expect(status).toBe(200)
  })
})

describeDb('admin users: отключение, сброс и удаление', () => {
  it('отключение закрывает живые сессии', async () => {
    const { call, db } = setup()
    const victim = insertUser(db, 'uvolen', 'editor')
    createSession(db, { userId: victim, state: 'active', ip: CLIENT_IP, ua: CLIENT_UA })

    const { status, payload } = await call('PATCH', `/api/admin/users/${victim}`, { status: 'disabled' })
    expect(status).toBe(200)

    const row = payload.users.find((user) => user.id === victim)
    expect(row.status).toBe('disabled')
    expect(row.sessionsOpen).toBe(0)
    expect(db.get('SELECT revoked_reason FROM sessions WHERE user_id = ?', [victim]).revoked_reason).toBe('admin')
  })

  it('сброс второго фактора убирает секрет, коды и незавершённое подключение', async () => {
    const { call, db } = setup()
    const victim = insertUser(db, 'poteryal-telefon', 'admin')
    const victimSession = createSession(db, { userId: victim, state: 'active', ip: CLIENT_IP, ua: CLIENT_UA })

    db.run(
      `INSERT INTO totp_secrets (user_id, secret_ct, secret_iv, secret_tag, confirmed_at)
       VALUES (?, x'00', x'000000000000000000000000', x'00000000000000000000000000000000', 1)`,
      [victim]
    )
    db.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [victim, 'hash-1'])
    db.run(
      `INSERT INTO totp_pending (user_id, session_id, secret_ct, secret_iv, secret_tag, created_at, expires_at)
       VALUES (?, ?, x'00', x'000000000000000000000000', x'00000000000000000000000000000000', ?, ?)`,
      [victim, victimSession.session.id, Date.now(), Date.now() + 600_000]
    )

    const { status, payload } = await call('POST', `/api/admin/users/${victim}/reset-2fa`, {})
    expect(status).toBe(200)
    expect(payload).toMatchObject({ secrets: 1, codes: 1, pending: 1 })
    expect(db.get('SELECT COUNT(*) AS n FROM totp_secrets WHERE user_id = ?', [victim]).n).toBe(0)
    expect(db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?', [victim]).n).toBe(0)
    expect(db.get('SELECT COUNT(*) AS n FROM totp_pending WHERE user_id = ?', [victim]).n).toBe(0)
  })

  it('сброс пароля выдаёт новый временный и выгоняет из панели', async () => {
    const { call, db } = setup()
    const victim = insertUser(db, 'zabyl-parol', 'editor')
    createSession(db, { userId: victim, state: 'active', ip: CLIENT_IP, ua: CLIENT_UA })
    const before = db.get('SELECT password_hash FROM users WHERE id = ?', [victim]).password_hash

    const { status, payload } = await call('POST', `/api/admin/users/${victim}/reset-password`, {})
    expect(status).toBe(200)
    expect(payload.password).toHaveLength(24)
    expect(payload.revoked).toBe(1)

    const after = db.get('SELECT password_hash, must_change_password FROM users WHERE id = ?', [victim])
    expect(after.password_hash).not.toBe(before)
    expect(after.must_change_password).toBe(1)
  })

  it('удаление уносит учётку, но оставляет её след в журнале', async () => {
    const { call, db } = setup()
    const victim = insertUser(db, 'byvshiy', 'viewer')
    db.run(
      `INSERT INTO audit_log (at, user_id, actor, action, entity, result)
       VALUES (?, ?, 'byvshiy', 'content.update', 'content', 'ok')`,
      [Date.now(), victim]
    )

    const { status } = await call('DELETE', `/api/admin/users/${victim}`)
    expect(status).toBe(200)
    expect(db.get('SELECT COUNT(*) AS n FROM users WHERE id = ?', [victim]).n).toBe(0)

    // ON DELETE SET NULL: запись о действии остаётся, автор становится
    // неизвестным. История не должна исчезать вместе с учёткой.
    const trace = db.get("SELECT user_id, actor FROM audit_log WHERE action = 'content.update'")
    expect(trace.user_id).toBeNull()
    expect(trace.actor).toBe('byvshiy')
  })
})

describeDb('admin users: разбор запроса', () => {
  it('роль и статус в одном запросе не принимаются', async () => {
    const { call, db } = setup()
    const victim = insertUser(db, 'oboe-srazu', 'viewer')
    const { status, payload } = await call('PATCH', `/api/admin/users/${victim}`, {
      role: 'editor',
      status: 'disabled',
    })
    expect(status).toBe(400)
    expect(payload.error).toBe('role_or_status')
  })

  it('пустое изменение не принимается', async () => {
    const { call, db } = setup()
    const victim = insertUser(db, 'nichego', 'viewer')
    const { status, payload } = await call('PATCH', `/api/admin/users/${victim}`, {})
    expect(status).toBe(400)
    expect(payload.error).toBe('role_or_status')
  })

  it.each([['0'], ['abc'], ['1e3']])('идентификатор "%s" — это 404, а не 400', async (id) => {
    const { call } = setup()
    const { status, payload } = await call('DELETE', `/api/admin/users/${id}`)
    expect(status).toBe(404)
    expect(payload.error).toBe('not_found')
  })

  it('несуществующий пользователь — 404', async () => {
    const { call } = setup()
    const { status, payload } = await call('DELETE', '/api/admin/users/99999')
    expect(status).toBe(404)
    expect(payload.error).toBe('not_found')
  })
})
