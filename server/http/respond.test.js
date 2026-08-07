// Security header assertions, one per configuration.
//
// HSTS is the header this project cannot afford to get wrong by default:
// includeSubDomains binds every sibling subdomain of the apex, preload writes
// the domain into browser builds, and neither can be withdrawn from a visitor
// who already received it. Both therefore have to be off unless configured,
// and each configuration is asserted here rather than assumed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const response = (method = 'GET') => ({
  req: { method },
  statusCode: 0,
  headersSent: false,
  writableEnded: false,
  headers: {},
  body: '',
  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value)
  },
  removeHeader(name) {
    delete this.headers[String(name).toLowerCase()]
  },
  end(chunk) {
    this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    this.writableEnded = true
  },
})

/**
 * config.js reads process.env once at import, which is the point of the module.
 * Testing "each configuration" therefore means re-importing it with a different
 * environment rather than mutating a frozen object.
 */
const loadWith = async (env) => {
  vi.resetModules()
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return import('./respond.js')
}

describe('Strict-Transport-Security policy', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_ORIGIN', 'https://www.prohvac.uz')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('sends max-age alone by default, without binding any subdomain', async () => {
    const { securityHeaders } = await loadWith({})
    const res = response()

    securityHeaders(res)

    expect(res.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('adds includeSubDomains only when it is switched on', async () => {
    const { securityHeaders } = await loadWith({ HSTS_INCLUDE_SUBDOMAINS: '1' })
    const res = response()

    securityHeaders(res)

    expect(res.headers['strict-transport-security'])
      .toBe('max-age=31536000; includeSubDomains')
  })

  it('adds preload only alongside includeSubDomains', async () => {
    const { securityHeaders } = await loadWith({
      HSTS_INCLUDE_SUBDOMAINS: '1',
      HSTS_PRELOAD: '1',
    })
    const res = response()

    securityHeaders(res)

    expect(res.headers['strict-transport-security'])
      .toBe('max-age=31536000; includeSubDomains; preload')
  })

  it('honours a custom max-age', async () => {
    const { securityHeaders } = await loadWith({ HSTS_MAX_AGE: '600' })
    const res = response()

    securityHeaders(res)

    expect(res.headers['strict-transport-security']).toBe('max-age=600')
  })

  it('refuses to start with preload that no browser list would accept', async () => {
    // preload without includeSubDomains is rejected by the preload list, so the
    // configuration promises a permanence it cannot deliver.
    await expect(loadWith({ HSTS_PRELOAD: '1' })).rejects.toThrow(/HSTS_PRELOAD/)
  })

  it('refuses preload with a max-age below the required year', async () => {
    await expect(
      loadWith({ HSTS_PRELOAD: '1', HSTS_INCLUDE_SUBDOMAINS: '1', HSTS_MAX_AGE: '600' })
    ).rejects.toThrow(/HSTS_PRELOAD/)
  })

  it('sends no HSTS outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { securityHeaders } = await loadWith({ HSTS_INCLUDE_SUBDOMAINS: '1' })
    const res = response()

    securityHeaders(res)

    expect(res.headers['strict-transport-security']).toBeUndefined()
  })
})

describe('baseline security headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('sets the isolation and sniffing headers on every response', async () => {
    const { securityHeaders } = await loadWith({})
    const res = response()
    res.headers.server = 'nginx/1.0'
    res.headers['x-powered-by'] = 'Express'

    securityHeaders(res)

    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(res.headers['permissions-policy']).toContain('geolocation=()')
    // Runtime fingerprints are a free list of CVEs to try.
    expect(res.headers.server).toBeUndefined()
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
})

describe('misdirected request response', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('answers a rejected authority with 421 and no app shell', async () => {
    const { misdirected } = await loadWith({})
    const res = response()

    misdirected(res)

    expect(res.statusCode).toBe(421)
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-frame-options']).toBe('DENY')
    // The SPA shell is exactly what a rebinding page wants executed in the
    // origin of the name it supplied, so it is never sent here.
    expect(res.body).not.toContain('<html')
    expect(res.body).toBe('Misdirected Request')
  })

  it('sends headers but no body for HEAD', async () => {
    const { misdirected } = await loadWith({})
    const res = response('HEAD')

    misdirected(res)

    expect(res.statusCode).toBe(421)
    expect(res.headers['content-length']).toBe('19')
    expect(res.body).toBe('')
  })

  it('writes nothing once the response is already sent', async () => {
    const { misdirected } = await loadWith({})
    const res = response()
    res.headersSent = true

    misdirected(res)

    expect(res.statusCode).toBe(0)
  })
})
