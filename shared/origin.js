const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

const asOriginList = (value) => {
  if (Array.isArray(value)) return value
  if (value == null || value === '') return []
  return String(value).split(',')
}

/**
 * Normalizes an HTTP origin to the exact form browsers use in the Origin
 * header. Paths, credentials and wildcard values are intentionally rejected:
 * an origin allowlist is not a URL-prefix or glob matcher.
 */
export const normalizeOrigin = (
  value,
  { allowHttp = false, label = 'origin' } = {}
) => {
  const input = String(value ?? '').trim()
  if (!input || input === 'null' || input === '*') {
    throw new TypeError(`${label} must be an explicit http(s) origin`)
  }

  let url
  try {
    url = new URL(input)
  } catch {
    throw new TypeError(`${label} must be a valid http(s) origin`)
  }

  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new TypeError(`${label} must use http or https`)
  }
  if (!allowHttp && url.protocol !== 'https:') {
    throw new TypeError(`${label} must use https`)
  }
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new TypeError(`${label} must not contain credentials, a path, query or fragment`)
  }

  return url.origin
}

/**
 * PUBLIC_ORIGIN is always part of the allowlist. ALLOWED_ORIGINS only extends
 * that list; it can never accidentally disable the site's own form.
 */
export const buildAllowedOrigins = ({
  publicOrigin,
  extraOrigins = [],
  allowHttp = false,
} = {}) => {
  const values = []
  if (String(publicOrigin ?? '').trim()) {
    values.push(normalizeOrigin(publicOrigin, { allowHttp, label: 'PUBLIC_ORIGIN' }))
  }

  for (const value of asOriginList(extraOrigins)) {
    const item = String(value ?? '').trim()
    if (!item) continue
    values.push(normalizeOrigin(item, { allowHttp, label: 'ALLOWED_ORIGINS' }))
  }

  return Object.freeze([...new Set(values)])
}

export const evaluateCorsOrigin = (requestOrigin, allowedOrigins) => {
  const input = String(requestOrigin ?? '').trim()
  if (!input) return Object.freeze({ allowed: true, origin: null })

  let origin
  try {
    // Development may legitimately use an http Origin. Whether such an
    // origin is configured is decided while building the allowlist.
    origin = normalizeOrigin(input, { allowHttp: true, label: 'Origin' })
  } catch {
    return Object.freeze({ allowed: false, origin: null })
  }

  return Object.freeze({
    allowed: allowedOrigins.includes(origin),
    origin,
  })
}

const appendVary = (res, token) => {
  const current = res.getHeader?.('Vary')
  const values = Array.isArray(current)
    ? current.flatMap((value) => String(value).split(','))
    : String(current ?? '').split(',')
  const normalized = values.map((value) => value.trim()).filter(Boolean)
  if (!normalized.some((value) => value.toLowerCase() === token.toLowerCase())) {
    normalized.push(token)
  }
  res.setHeader('Vary', normalized.join(', '))
}

/**
 * Applies response headers for an allowlisted Origin and returns the policy
 * decision. It deliberately never emits a wildcard or credentials header.
 */
export const applyCors = (
  req,
  res,
  allowedOrigins,
  {
    methods = 'POST, OPTIONS',
    headers = 'Content-Type',
    maxAge = 86_400,
  } = {}
) => {
  appendVary(res, 'Origin')
  const header = req?.headers?.origin
  if (Array.isArray(header)) {
    return Object.freeze({ allowed: false, origin: null })
  }
  const rawOrigin = typeof header === 'string' ? header.trim() : ''
  const decision = evaluateCorsOrigin(rawOrigin, allowedOrigins)
  if (!rawOrigin || !decision.allowed || !decision.origin) return decision

  res.setHeader('Access-Control-Allow-Origin', decision.origin)
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', headers)
  res.setHeader('Access-Control-Max-Age', String(maxAge))
  return decision
}
