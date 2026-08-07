import { config } from '../config.js'
import { hashIp, hashUa } from '../crypto/hashid.js'
import { attachRequestContext, evaluateRequestHost } from './request-context.js'

/**
 * The only runtime entry point for obtaining RequestContext.
 *
 * app.js attaches it before routing, while direct route tests and isolated
 * handlers may call this safely as well: attachment is idempotent and always
 * uses the same validated trusted-proxy policy and keyed hashes.
 */
export const ensureRequestContext = (req) =>
  attachRequestContext(req, {
    trustedProxyCidrs: config.trustedProxyCidrs,
    hashIp,
    hashUa,
  })

/**
 * Whether the request asked for a hostname this deployment answers for.
 *
 * The check exists for DNS rebinding: a name the attacker controls resolves to
 * this server, the browser then treats our responses as same-origin with that
 * name and reads them from a page the attacker wrote. Nothing about the socket
 * distinguishes such a request — only the authority does.
 *
 * The allowlist is config.trustedHosts (PUBLIC_ORIGIN plus TRUSTED_HOSTS), and
 * the proxy trust decision is the same one used for the client IP.
 */
export const isTrustedRequestHost = (req) =>
  evaluateRequestHost(req, {
    trustedProxyCidrs: config.trustedProxyCidrs,
    allowedHosts: config.trustedHosts,
  }).allowed
