// CR-041 / CR-042. The scenario behind these tests: SQLite is unusable when the
// process starts. Before the change that killed the whole site — the first
// request threw out of `ensureDbRoutes()` and every path, including the ones
// that never touch the database, answered 500. Recovery required restarting
// the Passenger pool.
//
// Both faults are injected through the real filesystem and the real node:sqlite
// driver, because the point is the classification the runtime makes:
//
//   - a directory in place of `app.sqlite` is a transient infrastructure fault
//     (the same shape as a locked or briefly missing file) and is retried on a
//     short backoff;
//   - DATA_DIR below a regular file is a permanent configuration fault and is
//     parked on the long cooldown instead.

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ADMIN_PATH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

let root
let server
let origin
let app
let db
let previousEnv

/** Boots the production request pipeline against a data directory of our choice. */
const boot = async (dataDir) => {
  vi.resetModules()
  process.env.DATA_DIR = dataDir
  process.env.ADMIN_SECRET_PATH = ADMIN_PATH
  process.env.ADMIN_REQUIRE_GATE = '0'

  app = await import('./app.js')
  db = await import('./db/index.js')

  server = createServer(app.handleRequest)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
}

const rememberEnv = () => {
  previousEnv = {
    DATA_DIR: process.env.DATA_DIR,
    ADMIN_SECRET_PATH: process.env.ADMIN_SECRET_PATH,
    ADMIN_REQUIRE_GATE: process.env.ADMIN_REQUIRE_GATE,
  }
}

const teardown = async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  server = null
  try {
    db?.closeDb()
  } catch {
    // An outage case may never have opened a connection; nothing to close.
  }
  rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers })

const postJson = (path, body) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('serving while SQLite is unreachable (CR-041)', () => {
  let dataDir

  beforeEach(async () => {
    rememberEnv()
    root = mkdtempSync(join(tmpdir(), 'prohvac-outage-'))
    dataDir = join(root, 'data')
    mkdirSync(dataDir)
    // A directory where the database file has to be: every open fails with
    // "unable to open database file", exactly as a locked or damaged path does.
    mkdirSync(join(dataDir, 'app.sqlite'))
    await boot(dataDir)
  })

  afterEach(teardown)

  it('serves the SPA shell while the database is unreachable', async () => {
    const response = await get('/', { Accept: 'text/html' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(await response.text()).toContain('<div id="root">')
  })

  it('serves static assets and bundled locales while the database is unreachable', async () => {
    const robots = await get('/robots.txt')
    expect(robots.status).toBe(200)

    // The locales route is database-backed; with the router unpublished the
    // request falls through to the files shipped in dist, so the site still
    // renders text instead of translation keys.
    const locales = await get('/locales/en/translation.json')
    expect(locales.status).toBe(200)
    expect(JSON.parse(await locales.text())).toBeTypeOf('object')
  })

  it('serves the admin shell behind the secret path', async () => {
    const shell = await get(`/${ADMIN_PATH}`, { Accept: 'text/html' })
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('<div id="root">')
  })

  it('answers database-backed APIs with 503, retry information and a request ID', async () => {
    const response = await postJson('/api/lead', { name: 'Test User', phone: '998900000000' })
    expect(response.status).toBe(503)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(response.headers.get('x-request-id')).toBeTruthy()

    const body = await response.json()
    expect(body).toMatchObject({ ok: false, error: 'service_unavailable' })
    expect(body.requestId).toBe(response.headers.get('x-request-id'))
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('leaks no stack trace, path or SQL in the 503 body', async () => {
    const body = await (await postJson('/api/lead', {})).text()
    expect(body).not.toContain('at ')
    expect(body).not.toContain('.sqlite')
    expect(body).not.toContain('SELECT')
    expect(body).not.toContain(root)
  })

  it('never reports the outage as a wrong password', async () => {
    const response = await postJson('/api/admin/session', {
      username: 'operator',
      password: 'not-the-real-password',
    })

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error).toBe('service_unavailable')
    expect(body.error).not.toBe('invalid_credentials')
  })

  it('reports a retryable runtime state without an error message', async () => {
    await get('/api/site/content')

    const status = app.runtimeInitializationStatus()
    expect(status).toMatchObject({
      state: 'failed_temporarily',
      ready: false,
      canRetry: true,
      permanent: false,
    })
    expect(status.nextRetryAt).toBeGreaterThan(Date.now() - 1_000)
    expect(JSON.stringify(status)).not.toContain(root)
    expect(JSON.stringify(status)).not.toContain('unable to open')
  })

  it('starts serving the database-backed API again without restarting the process', async () => {
    expect((await postJson('/api/admin/session', { username: 'x', password: 'y' })).status).toBe(503)

    // The only thing that changes: the database file can be created again.
    rmSync(join(dataDir, 'app.sqlite'), { recursive: true, force: true })

    const deadline = Date.now() + 20_000
    let response = null
    while (Date.now() < deadline) {
      response = await get('/api/admin/session')
      if (response.status !== 503) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    expect(response.status).not.toBe(503)
    expect(app.runtimeInitializationStatus()).toMatchObject({ state: 'ready', ready: true })

    // A real credential check now runs: the request that answered 503 during
    // the outage answers 401 once the database is back.
    const login = await postJson('/api/admin/session', {
      username: 'operator',
      password: 'not-the-real-password',
    })
    expect(login.status).toBe(401)
    expect((await login.json()).error).toBe('invalid_credentials')
  }, 30_000)
})

describe('serving with a broken data directory (CR-042)', () => {
  beforeEach(async () => {
    rememberEnv()
    root = mkdtempSync(join(tmpdir(), 'prohvac-misconfigured-'))
    // A regular file where the data directory has to be: mkdir below it fails
    // the way a wrong DATA_DIR or a lost mount does, and no amount of retrying
    // fixes it.
    const blocker = join(root, 'blocked')
    writeFileSync(blocker, 'not a directory')
    await boot(join(blocker, 'data'))
  })

  afterEach(teardown)

  it('keeps serving static content and parks the runtime as degraded', async () => {
    expect((await get('/', { Accept: 'text/html' })).status).toBe(200)
    expect((await postJson('/api/lead', {})).status).toBe(503)

    const status = app.runtimeInitializationStatus()
    expect(status).toMatchObject({ state: 'degraded', permanent: true, canRetry: true })
    // Parked, not abandoned: an operator who fixes DATA_DIR gets a working site
    // on the next retry rather than after a restart of the pool.
    expect(status.nextRetryAt).toBeGreaterThan(Date.now())
  })
})

describe('serving with a healthy database', () => {
  beforeEach(async () => {
    rememberEnv()
    root = mkdtempSync(join(tmpdir(), 'prohvac-healthy-'))
    await boot(join(root, 'data'))
  })

  afterEach(teardown)

  it('registers every route exactly once under concurrent first requests', async () => {
    // Concurrent cold requests used to be the way to register the routers
    // twice: each caller ran initialization on its own. The router now refuses
    // a duplicate registration outright, so a second pass would surface here as
    // a 500 rather than as a silently shadowed handler.
    const responses = await Promise.all([
      get('/api/site/content'),
      get('/api/site/content'),
      get('/api/site/content'),
      get('/locales/en/translation.json'),
    ])

    for (const response of responses) expect(response.status).toBe(200)
    expect(app.runtimeInitializationStatus()).toMatchObject({
      state: 'ready',
      attempts: 1,
      failures: 0,
    })
  })

  it('refuses to hide a handler behind a duplicate registration', async () => {
    const { createRouter } = await import('./router.js')
    const router = createRouter()
    router.register('GET', '/api/thing', () => {})

    expect(() => router.register('GET', '/api/thing', () => {})).toThrow(TypeError)
    expect(() => router.register('ALL', '/api/thing', () => {})).toThrow(TypeError)
    expect(() => router.register('POST', '/api/thing', () => {})).not.toThrow()
  })
})
