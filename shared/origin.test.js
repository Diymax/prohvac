import { describe, expect, it } from 'vitest'

import {
  applyCors,
  buildAllowedOrigins,
  evaluateCorsOrigin,
  normalizeOrigin,
} from './origin.js'

const response = () => {
  const values = new Map()
  return {
    getHeader: (name) => values.get(name.toLowerCase()),
    setHeader: (name, value) => values.set(name.toLowerCase(), value),
    values,
  }
}

describe('origin registry', () => {
  it('always includes PUBLIC_ORIGIN and treats ALLOWED_ORIGINS as additions', () => {
    expect(
      buildAllowedOrigins({
        publicOrigin: 'https://main.example/',
        extraOrigins: 'https://extra.example, https://main.example',
      })
    ).toEqual(['https://main.example', 'https://extra.example'])
  })

  it('normalizes scheme, hostname, default port and trailing slash', () => {
    expect(normalizeOrigin('HTTPS://EXAMPLE.COM:443/')).toBe('https://example.com')
    expect(normalizeOrigin('http://LOCALHOST:80/', { allowHttp: true })).toBe(
      'http://localhost'
    )
  })

  it('keeps non-default ports distinct', () => {
    const origins = buildAllowedOrigins({
      publicOrigin: 'https://example.com:8443',
      extraOrigins: 'https://example.com',
    })

    expect(origins).toEqual(['https://example.com:8443', 'https://example.com'])
  })

  it('rejects paths, wildcard, opaque and malformed origins', () => {
    expect(() => normalizeOrigin('https://example.com/form')).toThrow(/must not contain/)
    expect(() => normalizeOrigin('*')).toThrow(/explicit/)
    expect(() => normalizeOrigin('null')).toThrow(/explicit/)
    expect(() => normalizeOrigin('not a URL')).toThrow(/valid/)
  })

  it('allows the primary form even when no extra origins are configured', () => {
    const origins = buildAllowedOrigins({ publicOrigin: 'https://main.example' })

    expect(evaluateCorsOrigin('https://main.example/', origins)).toEqual({
      allowed: true,
      origin: 'https://main.example',
    })
    expect(evaluateCorsOrigin('https://other.example', origins).allowed).toBe(false)
  })
})

describe('applyCors', () => {
  it('echoes an allowlisted origin without wildcard or credentials', () => {
    const res = response()
    res.setHeader('Vary', 'Accept-Encoding')
    const result = applyCors(
      { headers: { origin: 'https://main.example' } },
      res,
      ['https://main.example']
    )

    expect(result.allowed).toBe(true)
    expect(res.getHeader('Access-Control-Allow-Origin')).toBe('https://main.example')
    expect(res.getHeader('Access-Control-Allow-Credentials')).toBeUndefined()
    expect(res.getHeader('Vary')).toBe('Accept-Encoding, Origin')
  })

  it('does not emit CORS headers for a denied or malformed origin', () => {
    for (const origin of ['https://other.example', 'not an origin', '*', [
      'https://main.example',
      'https://other.example',
    ]]) {
      const res = response()
      const result = applyCors({ headers: { origin } }, res, ['https://main.example'])
      expect(result.allowed).toBe(false)
      expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined()
      expect(res.getHeader('Vary')).toBe('Origin')
    }
  })

  it('permits same-origin requests without an Origin header but emits no allow header', () => {
    const res = response()
    const result = applyCors({ headers: {} }, res, ['https://main.example'])

    expect(result).toEqual({ allowed: true, origin: null })
    expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined()
  })
})
