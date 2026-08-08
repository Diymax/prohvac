// Who gets the homepage and who gets a 404.
//
// Written after the live site answered 404 to every client without a literal
// 'text/html' in Accept. Browsers send it; Telegram and WhatsApp link previews,
// facebookexternalhit and YandexBot send '*/*'. A link to the site pasted into
// a chat unfurled into nothing, and Yandex — the search engine that matters in
// this market — saw a page that does not exist. No test caught it.
//
// The shell is served from dist/index.html, so this suite needs a prior build,
// like every other suite that touches the shell.

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const ADMIN_PATH = 'b2c3d4e5f60718293a4b5c6d7e8f9012'

let server
let origin
let db
let root
let previousEnv

beforeAll(async () => {
  previousEnv = {
    DATA_DIR: process.env.DATA_DIR,
    ADMIN_SECRET_PATH: process.env.ADMIN_SECRET_PATH,
    ADMIN_REQUIRE_GATE: process.env.ADMIN_REQUIRE_GATE,
  }

  root = mkdtempSync(join(tmpdir(), 'prohvac-accept-'))
  vi.resetModules()
  process.env.DATA_DIR = root
  process.env.ADMIN_SECRET_PATH = ADMIN_PATH
  process.env.ADMIN_REQUIRE_GATE = '0'

  const app = await import('./app.js')
  db = await import('./db/index.js')

  server = createServer(app.handleRequest)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  try {
    db?.closeDb()
  } catch {
    // A connection may never have been opened; nothing to close.
  }
  rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const get = (headers) => fetch(`${origin}/`, { headers, redirect: 'manual' })

describe('homepage and the Accept header', () => {
  it('serves a browser', async () => {
    const response = await get({ Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' })
    expect(response.status).toBe(200)
  })

  it('serves a link preview that asks for any type', async () => {
    const response = await get({ Accept: '*/*', 'User-Agent': 'TelegramBot (like TwitterBot)' })
    expect(response.status).toBe(200)
  })

  it('serves a client that sends no Accept at all', async () => {
    // fetch fills in its own Accept, so the empty value is set explicitly —
    // this is how simple monitors and some libraries behave.
    const response = await get({ Accept: '' })
    expect(response.status).toBe(200)
  })

  it('does not serve a request that asks for an image only', async () => {
    // Such a request is not looking for the homepage: it is a link to a missing
    // asset, and HTML in reply would be noise.
    const response = await get({ Accept: 'image/avif,image/webp' })
    expect(response.status).toBe(404)
  })
})
