import { describe, expect, it, vi } from 'vitest'

import {
  attachRequestContext,
  compileTrustedProxyCidrs,
  normalizeClientIp,
  resolveClientIp,
} from './request-context.js'

const request = (remoteAddress, headers = {}) => ({
  headers,
  socket: { remoteAddress },
})

describe('resolveClientIp', () => {
  it('ignores spoofed forwarding headers from a direct client', () => {
    const req = request('203.0.113.9', {
      'x-real-ip': '192.0.2.10',
      'x-forwarded-for': '192.0.2.11',
    })

    expect(resolveClientIp(req, compileTrustedProxyCidrs('127.0.0.1/32'))).toBe(
      '203.0.113.9'
    )
  })

  it('accepts X-Real-IP only from an explicitly trusted proxy', () => {
    const req = request('127.0.0.1', { 'x-real-ip': '198.51.100.7' })

    expect(resolveClientIp(req, compileTrustedProxyCidrs('127.0.0.1/32'))).toBe(
      '198.51.100.7'
    )
  })

  it('walks X-Forwarded-For right-to-left through trusted proxies', () => {
    const req = request('10.0.0.5', {
      'x-forwarded-for': '198.51.100.8, 10.0.0.4',
    })

    expect(resolveClientIp(req, compileTrustedProxyCidrs('10.0.0.0/8'))).toBe(
      '198.51.100.8'
    )
  })

  it('stops at the first untrusted hop and ignores attacker-controlled values to its left', () => {
    const req = request('10.0.0.5', {
      'x-forwarded-for': '192.0.2.99, 198.51.100.8, 10.0.0.4',
    })

    expect(resolveClientIp(req, compileTrustedProxyCidrs('10.0.0.0/8'))).toBe(
      '198.51.100.8'
    )
  })

  it('normalizes IPv4 ports and IPv4-mapped IPv6', () => {
    expect(normalizeClientIp('192.0.2.4:443')).toBe('192.0.2.4')
    expect(normalizeClientIp('::ffff:192.0.2.4')).toBe('192.0.2.4')
    expect(normalizeClientIp('[::ffff:c000:204]:443')).toBe('192.0.2.4')
  })

  it('normalizes IPv6 and matches an IPv6 trusted-proxy CIDR', () => {
    const req = request('2001:0db8:0001:0000:0000:0000:0000:0002', {
      'x-forwarded-for': '2001:db8:ffff::9',
    })

    expect(normalizeClientIp('2001:0db8:0000:0000:0000:ff00:0042:8329')).toBe(
      '2001:db8::ff00:42:8329'
    )
    expect(resolveClientIp(req, compileTrustedProxyCidrs('2001:db8:1::/48'))).toBe(
      '2001:db8:ffff::9'
    )
  })

  it('falls back to the socket peer when the trusted chain is malformed', () => {
    const req = request('10.0.0.5', {
      'x-forwarded-for': '198.51.100.8, definitely-not-an-ip',
    })

    expect(resolveClientIp(req, compileTrustedProxyCidrs('10.0.0.0/8'))).toBe('10.0.0.5')
  })

  it('rejects malformed CIDRs instead of silently trusting the wrong range', () => {
    expect(() => compileTrustedProxyCidrs('10.0.0.0/99')).toThrow(/out of range/)
    expect(() => compileTrustedProxyCidrs('not-an-ip')).toThrow(/invalid trusted proxy/)
  })
})

describe('attachRequestContext', () => {
  it('attaches one immutable context with hashes and a server-generated request ID', () => {
    const req = request('203.0.113.9', {
      origin: 'https://example.com',
      'user-agent': 'Test Agent',
    })
    const hashIp = vi.fn((value) => `ip:${value}`)
    const hashUa = vi.fn((value) => `ua:${value}`)

    const context = attachRequestContext(req, {
      hashIp,
      hashUa,
      now: () => 1_700_000_000_000,
      requestId: () => 'server-request-id',
    })

    expect(context).toEqual({
      requestId: 'server-request-id',
      clientIp: '203.0.113.9',
      ipHash: 'ip:203.0.113.9',
      userAgent: 'Test Agent',
      userAgentHash: 'ua:Test Agent',
      origin: 'https://example.com',
      timestamp: 1_700_000_000_000,
    })
    expect(Object.isFrozen(context)).toBe(true)
    expect(req.context).toBe(context)
    expect(req.requestContext).toBe(context)
    expect(attachRequestContext(req, { hashIp, hashUa })).toBe(context)
    expect(hashIp).toHaveBeenCalledOnce()
    expect(hashUa).toHaveBeenCalledOnce()
  })
})

// A Unix-socket connection has no peer address, and before this change such a
// request got neither an address of its own nor trust in the headers. On the
// live server under Passenger that meant one ip_hash for every visitor.
describe('resolveClientIp over a Unix socket', () => {
  const loopback = compileTrustedProxyCidrs('127.0.0.1/32,::1/128')

  const request = (headers = {}) => ({ socket: {}, headers })

  it('takes the address from X-Forwarded-For when loopback is trusted', () => {
    expect(resolveClientIp(request({ 'x-forwarded-for': '203.0.113.7' }), loopback)).toBe('203.0.113.7')
  })

  it('takes the address from X-Real-IP when X-Forwarded-For is absent', () => {
    expect(resolveClientIp(request({ 'x-real-ip': '203.0.113.8' }), loopback)).toBe('203.0.113.8')
  })

  it('tells two visitors apart instead of merging them into one hash', () => {
    const first = resolveClientIp(request({ 'x-forwarded-for': '203.0.113.7' }), loopback)
    const second = resolveClientIp(request({ 'x-forwarded-for': '198.51.100.4' }), loopback)
    expect(first).not.toBe(second)
  })

  it('does not trust the headers when the proxy list is empty', () => {
    expect(resolveClientIp(request({ 'x-forwarded-for': '203.0.113.7' }), [])).toBe(null)
  })

  it('keeps the last untrusted hop of the chain', () => {
    const chain = { 'x-forwarded-for': '203.0.113.7, 127.0.0.1' }
    expect(resolveClientIp(request(chain), loopback)).toBe('203.0.113.7')
  })
})
