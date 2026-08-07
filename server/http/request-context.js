import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

const IPV4_BITS = 32
const IPV6_BITS = 128
const MAX_USER_AGENT = 512
const MAX_ORIGIN = 2048
const hasHeaderControls = (value) => {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

const parseIpv4 = (value) => {
  if (isIP(value) !== 4) return null
  const octets = value.split('.').map(Number)
  const numeric = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n)
  return { family: 4, bits: IPV4_BITS, numeric, groups: octets }
}

const expandIpv6 = (value) => {
  let input = value.toLowerCase()
  const zoneIndex = input.indexOf('%')
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex)
  if (isIP(input) !== 6) return null

  const lastColon = input.lastIndexOf(':')
  const ipv4Tail = input.slice(lastColon + 1)
  if (ipv4Tail.includes('.')) {
    const ipv4 = parseIpv4(ipv4Tail)
    if (!ipv4) return null
    input = `${input.slice(0, lastColon)}:${(
      (ipv4.groups[0] << 8) | ipv4.groups[1]
    ).toString(16)}:${((ipv4.groups[2] << 8) | ipv4.groups[3]).toString(16)}`
  }

  const halves = input.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null
  }

  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ].map((group) => Number.parseInt(group, 16))
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return null
  return groups
}

const compressIpv6 = (groups) => {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1
      continue
    }
    let end = index
    while (end < groups.length && groups[end] === 0) end += 1
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index
      bestLength = end - index
    }
    index = end
  }

  const values = groups.map((group) => group.toString(16))
  if (bestStart === -1) return values.join(':')
  const left = values.slice(0, bestStart).join(':')
  const right = values.slice(bestStart + bestLength).join(':')
  if (!left && !right) return '::'
  if (!left) return `::${right}`
  if (!right) return `${left}::`
  return `${left}::${right}`
}

const parseIp = (value) => {
  const ipv4 = parseIpv4(value)
  if (ipv4) return { ...ipv4, canonical: ipv4.groups.join('.') }

  const groups = expandIpv6(value)
  if (!groups) return null
  const numeric = groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n)

  // Treat IPv4-mapped IPv6 as IPv4 so a client cannot obtain separate rate
  // limit buckets merely by switching textual address notation.
  if ((numeric >> 32n) === 0xffffn) {
    const mapped = Number(numeric & 0xffff_ffffn)
    const octets = [
      (mapped >>> 24) & 255,
      (mapped >>> 16) & 255,
      (mapped >>> 8) & 255,
      mapped & 255,
    ]
    return {
      family: 4,
      bits: IPV4_BITS,
      numeric: BigInt(mapped),
      groups: octets,
      canonical: octets.join('.'),
    }
  }

  return {
    family: 6,
    bits: IPV6_BITS,
    numeric,
    groups,
    canonical: compressIpv6(groups),
  }
}

const stripAddressPort = (value) => {
  const input = String(value ?? '').trim()
  if (!input || hasHeaderControls(input)) return null

  if (input.startsWith('[')) {
    const match = input.match(/^\[([^\]]+)\](?::([0-9]{1,5}))?$/)
    if (!match || (match[2] && Number(match[2]) > 65535)) return null
    return match[1]
  }
  if (isIP(input)) return input

  const ipv4Port = input.match(/^([^:]+):([0-9]{1,5})$/)
  if (ipv4Port && Number(ipv4Port[2]) <= 65535 && isIP(ipv4Port[1]) === 4) {
    return ipv4Port[1]
  }
  return null
}

export const normalizeClientIp = (value) => {
  const address = stripAddressPort(value)
  if (!address) return null
  return parseIp(address)?.canonical ?? null
}

const parseCidr = (value) => {
  const input = String(value ?? '').trim()
  if (!input) throw new TypeError('trusted proxy CIDR must not be empty')
  const separator = input.indexOf('/')
  const address = separator === -1 ? input : input.slice(0, separator)
  const normalized = normalizeClientIp(address)
  const parsed = normalized ? parseIp(normalized) : null
  if (!parsed) throw new TypeError(`invalid trusted proxy address "${input}"`)

  const prefixText = separator === -1 ? String(parsed.bits) : input.slice(separator + 1)
  if (!/^\d{1,3}$/.test(prefixText)) {
    throw new TypeError(`invalid trusted proxy prefix "${input}"`)
  }
  const prefix = Number(prefixText)
  if (prefix < 0 || prefix > parsed.bits) {
    throw new TypeError(`trusted proxy prefix is out of range "${input}"`)
  }

  const shift = BigInt(parsed.bits - prefix)
  const network = shift === 0n ? parsed.numeric : (parsed.numeric >> shift) << shift
  return Object.freeze({
    source: input,
    family: parsed.family,
    bits: parsed.bits,
    prefix,
    network,
  })
}

export const compileTrustedProxyCidrs = (value) => {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',')
  return Object.freeze(
    entries
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean)
      .map(parseCidr)
  )
}

const isTrusted = (address, trustedProxyCidrs) => {
  const parsed = address ? parseIp(address) : null
  if (!parsed) return false
  return trustedProxyCidrs.some((cidr) => {
    if (cidr.family !== parsed.family) return false
    const shift = BigInt(cidr.bits - cidr.prefix)
    const network = shift === 0n ? parsed.numeric : (parsed.numeric >> shift) << shift
    return network === cidr.network
  })
}

const combinedHeader = (value) => {
  if (Array.isArray(value)) return value.join(',')
  return typeof value === 'string' ? value : ''
}

/**
 * Uses forwarding headers only when the immediate socket peer is trusted.
 * X-Forwarded-For is walked right-to-left and stops at the first untrusted
 * hop; anything further left could have been supplied by that client.
 */
export const resolveClientIp = (req, trustedProxyCidrs = []) => {
  const peer = normalizeClientIp(req?.socket?.remoteAddress)
  if (!peer || !isTrusted(peer, trustedProxyCidrs)) return peer

  const forwarded = combinedHeader(req?.headers?.['x-forwarded-for'])
  if (forwarded.trim()) {
    const candidates = forwarded.split(',').map((part) => part.trim())
    if (candidates.some((candidate) => !candidate)) return peer

    let current = peer
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (!isTrusted(current, trustedProxyCidrs)) break
      const candidate = normalizeClientIp(candidates[index])
      if (!candidate) return peer
      current = candidate
    }
    return current
  }

  const realIp = req?.headers?.['x-real-ip']
  if (Array.isArray(realIp)) return peer
  return normalizeClientIp(realIp) ?? peer
}

// A Host header can never be longer than this: DNS caps a name at 253 octets
// and the ":65535" suffix adds six more. Anything longer is malformed input,
// and rejecting it early keeps the parsers below working on bounded strings.
const MAX_HOST = 259
const MAX_DNS_NAME = 253

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Reduces a registered name to the single spelling used for comparison.
 * A trailing dot is the DNS root and denotes the same host, so it is removed
 * rather than allowed to become a second, unmatched spelling of one name.
 */
const normalizeRegisteredName = (value) => {
  const text = value.endsWith('.') ? value.slice(0, -1) : value
  if (!text || text.length > MAX_DNS_NAME) return null
  return text.split('.').every((label) => HOST_LABEL.test(label)) ? text : null
}

/**
 * Canonicalizes an authority taken from Host, :authority or X-Forwarded-Host.
 *
 * Returns { hostname, port, canonical } or null. null means the value is not a
 * well-formed authority at all: case, a trailing DNS dot, an IPv6 literal
 * spelled long-hand and an IPv4-mapped IPv6 address all reduce to one form, so
 * an allowlist comparison cannot be defeated by respelling the same name.
 */
export const normalizeHost = (value) => {
  // An array means the request carried the header twice. Which one the front
  // end acted on is unknowable, so neither is accepted.
  if (Array.isArray(value)) return null

  const input = String(value ?? '')
  // Controls are checked before trimming: trim() would silently drop a
  // trailing CRLF and turn a header-injection attempt into a valid host.
  if (!input || input.length > MAX_HOST || hasHeaderControls(input)) return null

  const text = input.trim().toLowerCase()
  if (!text || /\s/.test(text)) return null
  // Userinfo, path, query and fragment characters do not belong to an
  // authority. Accepting them would compare "evil.com" against an allowlist
  // entry hidden behind "trusted.example@evil.com".
  if (/[@/\\?#]/.test(text)) return null

  let hostname = text
  let portText = ''

  if (text.startsWith('[')) {
    const match = text.match(/^\[([^\]]*)\](?::(\d{1,5}))?$/)
    if (!match) return null
    const parsed = parseIp(match[1])
    if (!parsed) return null
    // parseIp folds IPv4-mapped IPv6 down to IPv4, so the bracket form is kept
    // only for addresses that are genuinely IPv6.
    hostname = parsed.family === 6 ? `[${parsed.canonical}]` : parsed.canonical
    portText = match[2] ?? ''
  } else {
    const colon = text.indexOf(':')
    if (colon !== -1) {
      // A second colon means an IPv6 literal written without brackets, which
      // is malformed in an authority and ambiguous against the port separator.
      if (text.indexOf(':', colon + 1) !== -1) return null
      hostname = text.slice(0, colon)
      portText = text.slice(colon + 1)
      if (!portText) return null
    }

    // parseIpv4 reports the octets; the dotted form is the canonical spelling
    // (parseIp assembles the same string for the IPv6-mapped case).
    const ipv4 = parseIpv4(hostname)
    if (ipv4) hostname = ipv4.groups.join('.')
    else {
      const name = normalizeRegisteredName(hostname)
      if (!name) return null
      hostname = name
    }
  }

  let port = null
  if (portText) {
    if (!/^\d{1,5}$/.test(portText)) return null
    port = Number(portText)
    if (port < 1 || port > 65535) return null
  }

  return Object.freeze({
    hostname,
    port,
    canonical: port === null ? hostname : `${hostname}:${port}`,
  })
}

/** Builds the host allowlist. An unusable entry is a configuration error. */
export const compileAllowedHosts = (value) => {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',')
  return Object.freeze(
    entries
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean)
      .map((entry) => {
        const host = normalizeHost(entry)
        if (!host) throw new TypeError(`invalid trusted host "${entry}"`)
        return host
      })
  )
}

/**
 * An allowlist entry without a port matches the host on any port: which port a
 * reverse proxy forwards is a deployment detail, while the hostname is the part
 * a DNS-rebinding attacker controls. An entry that does name a port pins it.
 *
 * An empty allowlist matches nothing. Treating "not configured" as "allow
 * everything" would turn a missing PUBLIC_ORIGIN into a silently disabled check.
 */
export const isHostAllowed = (host, allowedHosts = []) => {
  if (!host) return false
  return allowedHosts.some(
    (entry) => entry.hostname === host.hostname && (entry.port === null || entry.port === host.port)
  )
}

/** Whether the immediate socket peer is one of the configured proxies. */
export const isTrustedPeer = (req, trustedProxyCidrs = []) => {
  const peer = normalizeClientIp(req?.socket?.remoteAddress)
  return Boolean(peer) && isTrusted(peer, trustedProxyCidrs)
}

/**
 * The authority the client asked for, or null when it cannot be established.
 *
 * Host and :authority must agree whenever both are present: a disagreement is
 * exactly how a request is routed past a front end that inspects only one of
 * them. X-Forwarded-Host is honoured only when the immediate peer is a trusted
 * proxy, reusing the same trust decision as resolveClientIp.
 */
export const resolveRequestHost = (req, trustedProxyCidrs = []) => {
  const headers = req?.headers ?? {}
  const authority = headers[':authority']
  const host = headers.host

  let claimed
  if (authority !== undefined && host !== undefined) {
    const fromAuthority = normalizeHost(authority)
    const fromHost = normalizeHost(host)
    if (!fromAuthority || !fromHost || fromAuthority.canonical !== fromHost.canonical) return null
    claimed = fromAuthority
  } else {
    claimed = normalizeHost(authority !== undefined ? authority : host)
  }
  if (!claimed) return null

  const forwarded = headers['x-forwarded-host']
  if (forwarded === undefined) return claimed
  if (!isTrustedPeer(req, trustedProxyCidrs)) return claimed
  // A trusted proxy sets exactly one value. A list means some hop appended its
  // own, and there is no way to tell which entry the front end acted on.
  if (Array.isArray(forwarded) || String(forwarded).includes(',')) return null
  return normalizeHost(forwarded)
}

/** Single decision point: the normalized host plus whether it is allowed. */
export const evaluateRequestHost = (
  req,
  { trustedProxyCidrs = [], allowedHosts = [] } = {}
) => {
  const host = resolveRequestHost(req, trustedProxyCidrs)
  return Object.freeze({ host, allowed: isHostAllowed(host, allowedHosts) })
}

const safeHeader = (value, maxLength) => {
  if (Array.isArray(value)) return ''
  const text = String(value ?? '').trim()
  if (!text || hasHeaderControls(text)) return ''
  return text.slice(0, maxLength)
}

export const createRequestContext = (
  req,
  {
    trustedProxyCidrs = [],
    hashIp,
    hashUa,
    now = Date.now,
    requestId = randomUUID,
  } = {}
) => {
  if (typeof hashIp !== 'function' || typeof hashUa !== 'function') {
    throw new TypeError('createRequestContext requires hashIp and hashUa functions')
  }

  const clientIp = resolveClientIp(req, trustedProxyCidrs)
  const userAgent = safeHeader(req?.headers?.['user-agent'], MAX_USER_AGENT)
  const origin = safeHeader(req?.headers?.origin, MAX_ORIGIN)
  const timestamp = Number(now())

  return Object.freeze({
    requestId: String(requestId()),
    clientIp,
    ipHash: hashIp(clientIp),
    userAgent,
    userAgentHash: hashUa(userAgent),
    origin: origin || null,
    timestamp,
  })
}

export const attachRequestContext = (req, options) => {
  if (req.requestContext) return req.requestContext
  const context = createRequestContext(req, options)
  for (const property of ['requestContext', 'context']) {
    Object.defineProperty(req, property, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: context,
    })
  }
  return context
}

export const getRequestContext = (req) => {
  const context = req?.requestContext || req?.context
  if (!context) throw new TypeError('request context is not attached')
  return context
}
