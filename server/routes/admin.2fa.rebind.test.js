// CR-035. Rebinding TOTP must never leave the account without a second factor.
//
// The old enrollment wrote the candidate secret straight into `totp_secrets`
// and cleared `confirmed_at` in the same UPSERT, so the working factor was gone
// the moment the QR code appeared on screen — before a single code from the new
// authenticator had been verified. Everything below is written against the real
// route handlers and a real temporary SQLite database, because the property
// under test is a database state transition, not a branch in one function.

import { Readable } from 'node:stream'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashPassword } from '../auth/password.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { totpCode } from '../auth/totp.js'
import { config } from '../config.js'
import { PURPOSE, seal } from '../crypto/secretbox.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createRouter } from '../router.js'
import { loadConfirmedTotp, registerAdmin2faRoutes, SETUP_TTL_MS } from './admin.2fa.js'
import { registerAdminAuthRoutes } from './admin.auth.js'

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
  ? 'TOTP rebind (CR-035)'
  : `TOTP rebind (CR-035) — пропущено: node:sqlite недоступен (${unavailable})`

const PASSWORD = 'Severniy-Veter-7391!'
const CLIENT_IP = '203.0.113.29'
const CLIENT_UA = 'totp-rebind-test'
const PERIOD = 30

// Секрет, который уже привязан и работает. Значение фиксированное: тест должен
// уметь предъявить и проверить, что в аудит и логи оно не попало.
const OLD_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

let passwordHash = ''
beforeAll(async () => {
  if (available) passwordHash = await hashPassword(PASSWORD)
}, 30_000)

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

const allowingThrottle = () => ({
  hit: vi.fn(() => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
  reset: vi.fn(),
})

describeDb(suiteName, () => {
  let db
  let router
  let userId

  const invoke = async (request) => {
    const matched = router.match(request.method, request.url)
    if (!matched?.handler) throw new Error(`test route not found: ${request.method} ${request.url}`)

    const response = fakeRes()
    await matched.handler(request, response, matched.params)

    // uniform404 отдаёт не JSON, а страницу SPA: маскировка админки под
    // несуществующий адрес — это часть проверяемого поведения, и падать
    // на разборе тела тест не должен.
    let payload = null
    try {
      payload = response.body ? JSON.parse(response.body) : null
    } catch {
      payload = null
    }
    return { response, payload }
  }

  /** Полноценная сессия со свежим подтверждением пароля — вход в перепривязку. */
  const openSession = ({ reauthAt = Date.now(), state = 'active' } = {}) =>
    createSession(db, {
      userId,
      state,
      ip: CLIENT_IP,
      ua: CLIENT_UA,
      amr: state === 'active' ? 'pwd,otp' : 'pwd',
      reauthAt: state === 'active' ? reauthAt : null,
    })

  /** Подтверждённый второй фактор в базе — исходное состояние учётки. */
  const plantConfirmedFactor = (secret, at = Date.now()) => {
    const box = seal(secret, PURPOSE.totpSecret)
    db.run(
      `INSERT INTO totp_secrets (
         user_id, secret_ct, secret_iv, secret_tag,
         digits, period, algorithm, confirmed_at, last_used_step, created_at
       ) VALUES (?, ?, ?, ?, 6, ?, 'SHA1', ?, NULL, ?)`,
      [userId, box.ct, box.iv, box.tag, PERIOD, at, at]
    )
  }

  const activeSecret = () => loadConfirmedTotp(db, userId)?.secret ?? null

  const pendingRows = () => db.all('SELECT * FROM totp_pending WHERE user_id = ?', [userId])

  /**
   * Код для шага СЛЕДУЮЩЕГО за уже принятым. Брать код текущего шага нельзя:
   * подтверждение привязки записывает свой шаг в last_used_step, и тот же код
   * маршрут входа отвергнет как повторный (RFC 6238 §5.2) — то есть тест
   * падал бы на защите от повтора, а не на проверяемом свойстве.
   */
  const loginCode = (secret) => {
    const row = db.get('SELECT last_used_step FROM totp_secrets WHERE user_id = ?', [userId])
    const base = row?.last_used_step ?? Math.floor(Date.now() / 1000 / PERIOD) - 1
    return totpCode(secret, { timeMs: (base + 1) * PERIOD * 1000, period: PERIOD })
  }

  /** Полный вход паролем и кодом. Возвращает стадию, на которой всё кончилось. */
  const login = async (code) => {
    const first = await invoke(
      fakeReq({
        method: 'POST',
        url: '/api/admin/session',
        body: { username: 'rebind-user', password: PASSWORD },
      })
    )
    if (first.payload?.stage !== 'totp') return first

    const cookie = String(first.response.headers['set-cookie'])
    const token = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]

    return invoke(
      fakeReq({
        method: 'POST',
        url: '/api/admin/session/totp',
        token,
        csrfToken: first.payload.csrfToken,
        body: { code },
      })
    )
  }

  const startSetup = (session) =>
    invoke(
      fakeReq({
        method: 'POST',
        url: '/api/admin/2fa/setup',
        token: session.token,
        csrfToken: session.csrfToken,
        body: {},
      })
    )

  const confirmSetup = (session, code) =>
    invoke(
      fakeReq({
        method: 'POST',
        url: '/api/admin/2fa/confirm',
        token: session.token,
        csrfToken: session.csrfToken,
        body: { code },
      })
    )

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)

    const inserted = db.run(
      `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
       VALUES (?, ?, 'owner', 0, 1)`,
      ['rebind-user', passwordHash]
    )
    userId = Number(inserted.lastInsertRowid)

    router = createRouter()
    registerAdmin2faRoutes(router, { db })
    registerAdminAuthRoutes(router, {
      db,
      throttle: allowingThrottle(),
      escalation: { registerFailure: vi.fn(() => ({ blocked: false, delayMs: 0 })) },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  // -------------------------------------------------------------------------
  // Действующий фактор во время незавершённой перепривязки
  // -------------------------------------------------------------------------

  it('оставляет действующий секрет нетронутым, пока новый не подтверждён', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const before = db.get('SELECT * FROM totp_secrets WHERE user_id = ?', [userId])

    const session = openSession()
    const setup = await startSetup(session)

    expect(setup.response.statusCode).toBe(200)
    expect(setup.payload).toMatchObject({ ok: true, rebind: true })
    expect(setup.payload.secret).not.toBe(OLD_SECRET)

    const after = db.get('SELECT * FROM totp_secrets WHERE user_id = ?', [userId])
    expect(after.confirmed_at).toBe(before.confirmed_at)
    expect(Buffer.from(after.secret_ct).equals(Buffer.from(before.secret_ct))).toBe(true)
    expect(activeSecret()).toBe(OLD_SECRET)
    expect(pendingRows()).toHaveLength(1)
  })

  it('пускает по старому коду, пока идёт привязка нового', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    await startSetup(session)

    const result = await login(loginCode(OLD_SECRET))
    expect(result.response.statusCode).toBe(200)
    expect(result.payload).toMatchObject({ ok: true, stage: 'active' })
  })

  it('не пускает по неподтверждённому новому коду', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    const setup = await startSetup(session)

    const result = await login(totpCode(setup.payload.secret, { period: PERIOD }))
    expect(result.response.statusCode).toBe(401)
    expect(result.payload).toMatchObject({ ok: false, error: 'invalid_code' })
    expect(activeSecret()).toBe(OLD_SECRET)
  })

  it('брошенная привязка не отключает второй фактор', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    await startSetup(session)

    // Вкладку закрыли: confirm не пришёл никогда.
    expect(activeSecret()).toBe(OLD_SECRET)
    expect(db.get('SELECT COUNT(*) AS n FROM totp_secrets').n).toBe(1)

    const result = await login(loginCode(OLD_SECRET))
    expect(result.payload).toMatchObject({ ok: true, stage: 'active' })
  })

  // -------------------------------------------------------------------------
  // Подмена
  // -------------------------------------------------------------------------

  it('делает новый секрет действующим только после подтверждения', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    const setup = await startSetup(session)
    const next = setup.payload.secret

    expect(activeSecret()).toBe(OLD_SECRET)

    const confirmed = await confirmSetup(session, totpCode(next, { period: PERIOD }))
    expect(confirmed.response.statusCode).toBe(200)
    expect(confirmed.payload.recoveryCodes).toHaveLength(10)

    expect(activeSecret()).toBe(next)
    expect(pendingRows()).toHaveLength(0)
  })

  it('после подмены старый код перестаёт пускать', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    const setup = await startSetup(session)
    await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))

    const denied = await login(loginCode(OLD_SECRET))
    expect(denied.response.statusCode).toBe(401)
    expect(denied.payload).toMatchObject({ ok: false, error: 'invalid_code' })

    const allowed = await login(loginCode(setup.payload.secret))
    expect(allowed.response.statusCode).toBe(200)
    expect(allowed.payload).toMatchObject({ ok: true, stage: 'active' })
  })

  it('отзывает остальные сессии владельца и оставляет текущую', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    const other = openSession()
    const setup = await startSetup(session)

    await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))

    const rows = db.all('SELECT id, revoked_at, revoked_reason FROM sessions WHERE user_id = ?', [
      userId,
    ])
    const current = rows.find((row) => row.id === session.session.id)
    const revoked = rows.find((row) => row.id === other.session.id)

    expect(current.revoked_at).toBeNull()
    expect(revoked.revoked_at).not.toBeNull()
    expect(revoked.revoked_reason).toBe('logout_all')
  })

  it('первичная привязка по-прежнему проходит без действующего фактора', async () => {
    const session = openSession({ state: 'pending_totp' })
    const setup = await startSetup(session)

    expect(setup.response.statusCode).toBe(200)
    expect(setup.payload).toMatchObject({ ok: true, rebind: false })
    // Кандидат не должен появляться в таблице действующих факторов даже
    // на время: иначе `confirmed_at IS NULL` вернулся бы как состояние.
    expect(db.get('SELECT COUNT(*) AS n FROM totp_secrets').n).toBe(0)

    const confirmed = await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))
    expect(confirmed.response.statusCode).toBe(200)
    expect(confirmed.payload.recoveryCodes).toHaveLength(10)
    expect(activeSecret()).toBe(setup.payload.secret)
  })

  // -------------------------------------------------------------------------
  // Срок годности кандидата
  // -------------------------------------------------------------------------

  it('ставит кандидату срок в SETUP_TTL_MS и отвергает просроченный', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    const setup = await startSetup(session)
    const [pending] = pendingRows()

    expect(pending.expires_at - pending.created_at).toBe(SETUP_TTL_MS)
    expect(setup.payload.expiresAt).toBe(pending.expires_at)

    const past = Date.now() - SETUP_TTL_MS - 1000
    db.run('UPDATE totp_pending SET created_at = ?, expires_at = ? WHERE id = ?', [
      past,
      past + SETUP_TTL_MS,
      pending.id,
    ])

    const confirmed = await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))
    expect(confirmed.response.statusCode).toBe(409)
    expect(confirmed.payload).toEqual({ ok: false, error: 'totp_setup_expired' })

    expect(activeSecret()).toBe(OLD_SECRET)
    expect(pendingRows()).toHaveLength(0)

    const result = await login(loginCode(OLD_SECRET))
    expect(result.payload).toMatchObject({ ok: true, stage: 'active' })
  })

  it('убирает просроченных кандидатов при следующем setup', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const stale = openSession()
    await startSetup(stale)

    const past = Date.now() - SETUP_TTL_MS - 1000
    db.run('UPDATE totp_pending SET created_at = ?, expires_at = ?', [past, past + SETUP_TTL_MS])

    const fresh = openSession()
    await startSetup(fresh)

    const rows = pendingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].session_id).toBe(fresh.session.id)
  })

  // -------------------------------------------------------------------------
  // Параллельные привязки
  // -------------------------------------------------------------------------

  it('не даёт двум параллельным привязкам затереть друг друга', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const first = openSession()
    const second = openSession()

    const setupA = await startSetup(first)
    const setupB = await startSetup(second)

    expect(setupA.payload.secret).not.toBe(setupB.payload.secret)
    expect(pendingRows()).toHaveLength(2)

    // Код из чужой вкладки не подходит: кандидат привязан к своей сессии.
    const crossed = await confirmSetup(first, totpCode(setupB.payload.secret, { period: PERIOD }))
    expect(crossed.response.statusCode).toBe(400)
    expect(crossed.payload).toMatchObject({ ok: false, error: 'bad_totp' })
    expect(activeSecret()).toBe(OLD_SECRET)

    // Первая вкладка завершает свою привязку — секрет второй так и не стал
    // действующим и вообще перестал существовать.
    const confirmed = await confirmSetup(first, totpCode(setupA.payload.secret, { period: PERIOD }))
    expect(confirmed.response.statusCode).toBe(200)
    expect(activeSecret()).toBe(setupA.payload.secret)
    expect(pendingRows()).toHaveLength(0)

    // Вторая сессия отозвана вместе с остальными и больше ничего не подтвердит.
    const late = await confirmSetup(second, totpCode(setupB.payload.secret, { period: PERIOD }))
    expect(late.response.statusCode).toBe(404)
  })

  it('второе подтверждение той же привязки не выдаёт второй комплект кодов', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const session = openSession()
    const setup = await startSetup(session)
    const code = totpCode(setup.payload.secret, { period: PERIOD })

    const firstTry = await confirmSetup(session, code)
    expect(firstTry.response.statusCode).toBe(200)

    const secondTry = await confirmSetup(session, code)
    expect(secondTry.response.statusCode).toBe(409)
    expect(secondTry.payload).toEqual({ ok: false, error: 'totp_not_started' })
    expect(db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL').n).toBe(10)
  })

  // -------------------------------------------------------------------------
  // Отказ базы посреди подмены
  // -------------------------------------------------------------------------

  it('оставляет старый фактор целым, если подмена упала на записи в базу', async () => {
    plantConfirmedFactor(OLD_SECRET)
    db.run(
      'INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
      [userId, 'legacy-hash-1', Date.now()]
    )

    const session = openSession()
    const setup = await startSetup(session)

    const realRun = db.run.bind(db)
    vi.spyOn(db, 'run').mockImplementation((sql, params) => {
      if (String(sql).includes('INSERT INTO totp_secrets')) {
        throw new Error('disk I/O error')
      }
      return realRun(sql, params)
    })

    const confirmed = await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))
    expect(confirmed.response.statusCode).toBe(500)
    expect(confirmed.payload).toEqual({ ok: false, error: 'totp_swap_failed' })

    vi.restoreAllMocks()

    // Всё, что должно было измениться одной транзакцией, не изменилось:
    // фактор прежний, коды прежние, кандидат на месте.
    expect(activeSecret()).toBe(OLD_SECRET)
    expect(db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL').n).toBe(1)
    expect(pendingRows()).toHaveLength(1)

    const result = await login(loginCode(OLD_SECRET))
    expect(result.payload).toMatchObject({ ok: true, stage: 'active' })

    // Повтор той же привязки после починки базы доводит дело до конца.
    const retry = await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))
    expect(retry.response.statusCode).toBe(200)
    expect(activeSecret()).toBe(setup.payload.secret)
  })

  // -------------------------------------------------------------------------
  // Коды восстановления
  // -------------------------------------------------------------------------

  it('перевыпускает коды восстановления только вместе с удавшейся подменой', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const at = Date.now()
    for (const suffix of ['a', 'b', 'c']) {
      db.run('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)', [
        userId,
        `legacy-hash-${suffix}`,
        at,
      ])
    }

    const unused = () => db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL').n

    const session = openSession()
    const setup = await startSetup(session)
    expect(unused()).toBe(3)

    const wrong = await confirmSetup(session, '000000')
    expect(wrong.response.statusCode).toBe(400)
    expect(unused()).toBe(3)

    await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))
    expect(unused()).toBe(10)
    expect(db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL').n).toBe(3)
  })

  // -------------------------------------------------------------------------
  // Требование повторного подтверждения личности
  // -------------------------------------------------------------------------

  it('требует свежего подтверждения пароля для смены работающего фактора', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const stale = openSession({ reauthAt: Date.now() - 60 * 60_000 })

    const setup = await startSetup(stale)
    expect(setup.response.statusCode).toBe(403)
    expect(setup.payload).toMatchObject({ ok: false, error: 'reauth_required' })
    expect(pendingRows()).toHaveLength(0)
    expect(activeSecret()).toBe(OLD_SECRET)
  })

  it('не даёт менять работающий фактор из сессии, не прошедшей второй фактор', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const halfway = openSession({ state: 'pending_totp' })

    const setup = await startSetup(halfway)
    expect(setup.response.statusCode).toBe(404)
    expect(pendingRows()).toHaveLength(0)
    expect(activeSecret()).toBe(OLD_SECRET)
  })

  // -------------------------------------------------------------------------
  // Утечки
  // -------------------------------------------------------------------------

  it('не пишет ни секрет, ни коды восстановления в аудит и логи', async () => {
    plantConfirmedFactor(OLD_SECRET)
    const logs = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.join(' ')))
    }

    const session = openSession()
    const setup = await startSetup(session)
    const confirmed = await confirmSetup(session, totpCode(setup.payload.secret, { period: PERIOD }))
    expect(confirmed.response.statusCode).toBe(200)

    vi.restoreAllMocks()

    const auditDump = JSON.stringify(db.all('SELECT * FROM audit_log'))
    const logDump = logs.join('\n')
    const secrets = [OLD_SECRET, setup.payload.secret, ...confirmed.payload.recoveryCodes]

    for (const value of secrets) {
      expect(auditDump).not.toContain(value)
      expect(logDump).not.toContain(value)
      // Коды печатают без разделителя тоже — проверяем обе формы.
      expect(auditDump).not.toContain(value.replace('-', ''))
    }

    // Событие при этом записано и говорит о замене фактора.
    const event = db
      .all('SELECT action, result, diff FROM audit_log')
      .find((row) => row.action === '2fa.confirm')
    expect(event.result).toBe('ok')
    expect(JSON.parse(event.diff)).toEqual({
      rebind: true,
      recoveryCodes: 10,
      revokedSessions: 0,
    })
  })
})
