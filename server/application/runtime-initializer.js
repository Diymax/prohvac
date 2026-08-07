// Runtime initialization state machine (CR-010, extended by CR-042).
//
// The database-backed half of the application is initialized lazily, on the
// first request that needs it, and that attempt can fail: the data directory
// may be missing, the file may be held by a neighbouring pool process, or the
// configuration may simply be wrong. This module owns what happens next:
//
//   - concurrent callers share ONE attempt, so routes are never registered
//     twice and two attempts never run against the same database at once;
//   - a failure never parks the process forever — every state except `ready`
//     carries a scheduled next attempt;
//   - retries are spaced by exponential backoff with jitter, so a pool of
//     processes does not hammer a recovering disk in lockstep;
//   - a permanent configuration error is retried on a long cooldown instead of
//     the short transient one, because retrying faster cannot fix it;
//   - the exposed health status carries a classification and a timestamp, never
//     an error message: those routinely contain filesystem paths and SQL.
//
// The initializer itself must prepare state off to the side and publish it only
// after every step succeeds; that keeps retries safe even when route
// registration was the operation that failed.

export const INITIALIZATION_STATE = Object.freeze({
  IDLE: 'idle',
  INITIALIZING: 'initializing',
  READY: 'ready',
  // Permanent configuration error: retrying at the transient rate cannot help,
  // so the next attempt is pushed out to the long cooldown. The process keeps
  // serving everything that does not need the database.
  DEGRADED: 'degraded',
  // Transient infrastructure error: the next attempt is scheduled by backoff.
  FAILED_TEMPORARILY: 'failed_temporarily',
  SHUTTING_DOWN: 'shutting_down',
})

export const ERROR_CLASS = Object.freeze({
  CONFIGURATION: 'configuration',
  INFRASTRUCTURE: 'infrastructure',
})

// Failures an operator has to fix by hand. Retrying every few seconds would
// only produce noise, so these move the runtime to `degraded`.
const PERMANENT_CODES = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOTDIR',
  'ENAMETOOLONG',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'SQLITE_NOTADB',
  'SQLITE_CORRUPT',
  'SQLITE_READONLY',
])

// Programming and configuration mistakes surface as these constructors. They
// cannot be waited out either.
const PERMANENT_NAMES = new Set(['TypeError', 'SyntaxError', 'ReferenceError', 'RangeError'])

// A `cause` chain is normally one or two links deep; the bound only exists so a
// self-referencing cause cannot spin here forever.
const MAX_CAUSE_DEPTH = 4

// Error codes are machine identifiers (`SQLITE_BUSY`, `EACCES`), never free
// text, so publishing one cannot leak a path, a secret or a SQL fragment.
// Anything that does not look like an identifier is dropped.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

const safeCode = (error) => {
  const code = typeof error?.code === 'string' ? error.code : ''
  return SAFE_CODE.test(code) ? code : null
}

/**
 * Classifies a failed initialization attempt.
 *
 * Unknown failures are treated as transient on purpose: the cost of retrying a
 * permanent problem is a log line, while the cost of parking a transient one is
 * a site that stays down until somebody restarts the process.
 */
export const classifyInitializationError = (error, depth = 0) => {
  if (error?.permanent === true) return ERROR_CLASS.CONFIGURATION
  if (error?.transient === true) return ERROR_CLASS.INFRASTRUCTURE

  const code = typeof error?.code === 'string' ? error.code : ''
  if (PERMANENT_CODES.has(code)) return ERROR_CLASS.CONFIGURATION
  if (PERMANENT_NAMES.has(error?.name)) return ERROR_CLASS.CONFIGURATION

  if (error?.cause && depth < MAX_CAUSE_DEPTH) {
    return classifyInitializationError(error.cause, depth + 1)
  }
  return ERROR_CLASS.INFRASTRUCTURE
}

const positiveInt = (value, name) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`runtime initializer ${name} must be a non-negative integer`)
  }
  return value
}

/**
 * Coordinates database-backed initialization for one process.
 *
 * @param {object} options
 * @param {Function} options.initialize called as `initialize({ attempt })`;
 *   must be idempotent with respect to partially completed work.
 * @param {number} [options.baseDelayMs] first backoff step.
 * @param {number} [options.maxDelayMs] backoff ceiling.
 * @param {number} [options.cooldownMs] floor applied to every retry delay, so
 *   a burst of requests can never turn into a burst of attempts.
 * @param {number} [options.permanentDelayMs] cooldown for configuration errors.
 * @param {number} [options.jitterRatio] fraction of the delay spread randomly.
 * @param {Function} [options.classify] error classifier, for tests.
 * @param {Function} [options.onFailure] sanitized failure notification, called
 *   once per failed attempt (not once per waiting caller).
 * @param {Function} [options.now] clock, for tests.
 * @param {Function} [options.random] jitter source, for tests.
 */
export const createRuntimeInitializer = ({
  initialize,
  baseDelayMs = 500,
  maxDelayMs = 30_000,
  cooldownMs = 250,
  permanentDelayMs = 60_000,
  jitterRatio = 0.2,
  classify = classifyInitializationError,
  onFailure = null,
  now = Date.now,
  random = Math.random,
} = {}) => {
  if (typeof initialize !== 'function') {
    throw new TypeError('runtime initializer requires initialize()')
  }
  if (onFailure !== null && typeof onFailure !== 'function') {
    throw new TypeError('runtime initializer onFailure must be a function')
  }
  positiveInt(baseDelayMs, 'baseDelayMs')
  positiveInt(maxDelayMs, 'maxDelayMs')
  positiveInt(cooldownMs, 'cooldownMs')
  positiveInt(permanentDelayMs, 'permanentDelayMs')
  if (typeof jitterRatio !== 'number' || jitterRatio < 0 || jitterRatio >= 1) {
    throw new TypeError('runtime initializer jitterRatio must be within [0, 1)')
  }

  let state = INITIALIZATION_STATE.IDLE
  let promise = null
  let attempts = 0
  let failures = 0
  let lastError = null
  let errorClass = null
  let errorCode = null
  let errorName = null
  let nextRetryAt = null
  let lastSuccessAt = null
  let lastFailureAt = null

  /**
   * Exponential backoff with symmetric jitter, floored by the cooldown.
   * Jitter matters because Passenger runs several identical processes: without
   * it they would all retry on the same millisecond after a shared outage.
   */
  const retryDelay = (permanent) => {
    if (permanent) return Math.max(cooldownMs, permanentDelayMs)
    const exponent = Math.min(Math.max(failures - 1, 0), 30)
    const raw = Math.min(baseDelayMs * 2 ** exponent, maxDelayMs)
    const spread = raw * jitterRatio * (random() * 2 - 1)
    return Math.max(cooldownMs, Math.round(raw + spread))
  }

  const succeed = () => {
    // A shutdown that started while this attempt was in flight wins: publishing
    // `ready` afterwards would invite new database work into a closing process.
    if (state === INITIALIZATION_STATE.SHUTTING_DOWN) return
    state = INITIALIZATION_STATE.READY
    failures = 0
    lastError = null
    errorClass = null
    errorCode = null
    errorName = null
    nextRetryAt = null
    lastSuccessAt = now()
  }

  const fail = (error, attempt) => {
    failures += 1
    lastError = error
    errorClass = classify(error)
    errorCode = safeCode(error)
    errorName = typeof error?.name === 'string' ? error.name : null
    lastFailureAt = now()

    const permanent = errorClass === ERROR_CLASS.CONFIGURATION
    nextRetryAt = lastFailureAt + retryDelay(permanent)
    if (state !== INITIALIZATION_STATE.SHUTTING_DOWN) {
      state = permanent ? INITIALIZATION_STATE.DEGRADED : INITIALIZATION_STATE.FAILED_TEMPORARILY
    }

    if (onFailure) {
      // Notified once per attempt, so an outage under load does not multiply
      // the log by the request rate. The raw error is passed for the log only.
      onFailure({ attempt, failures, state, errorClass, errorCode, errorName, nextRetryAt, error })
    }
  }

  const start = () => {
    state = INITIALIZATION_STATE.INITIALIZING
    attempts += 1
    const attempt = attempts

    promise = Promise.resolve()
      .then(() => initialize({ attempt }))
      .then(
        () => {
          promise = null
          succeed()
        },
        (error) => {
          promise = null
          fail(error, attempt)
          throw error
        }
      )

    return promise
  }

  /**
   * Resolves once the database-backed runtime is usable.
   *
   * Rejects with the last failure while a retry is still on cooldown: the
   * caller is expected to answer 503 rather than wait out the backoff, because
   * holding the request open would only convert an outage into a timeout.
   */
  const ensure = () => {
    if (state === INITIALIZATION_STATE.READY) return Promise.resolve()
    if (state === INITIALIZATION_STATE.SHUTTING_DOWN) {
      return Promise.reject(lastError ?? new Error('runtime is shutting down'))
    }
    if (state === INITIALIZATION_STATE.INITIALIZING && promise) return promise
    if (nextRetryAt !== null && now() < nextRetryAt) return Promise.reject(lastError)
    return start()
  }

  const isReady = () => state === INITIALIZATION_STATE.READY

  /**
   * Health status. Deliberately free of error messages: they carry filesystem
   * paths and SQL text, and this object is rendered in the operations
   * dashboard. The class, the code and the next attempt are enough to act on.
   */
  const status = () => {
    const at = now()
    return Object.freeze({
      state,
      ready: state === INITIALIZATION_STATE.READY,
      attempts,
      failures,
      canRetry:
        state !== INITIALIZATION_STATE.READY && state !== INITIALIZATION_STATE.SHUTTING_DOWN,
      errorClass,
      errorCode,
      errorName,
      permanent: errorClass === ERROR_CLASS.CONFIGURATION,
      nextRetryAt,
      retryAfterMs: nextRetryAt === null ? null : Math.max(0, nextRetryAt - at),
      lastSuccessAt,
      lastFailureAt,
    })
  }

  /**
   * Refuses further attempts. Returns once an attempt already in flight has
   * settled, so a shutdown never races route publication.
   */
  const shutdown = () => {
    state = INITIALIZATION_STATE.SHUTTING_DOWN
    nextRetryAt = null
    return promise ? promise.then(() => undefined, () => undefined) : Promise.resolve()
  }

  return { ensure, isReady, status, shutdown }
}
