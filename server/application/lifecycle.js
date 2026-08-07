// Process lifecycle manager (CR-038).
//
// Before this module the process owned two bare `setInterval` handles and an
// `unhandledRejection` handler that logged and returned, so a shutdown could
// race a background tick and a broken promise chain left the process running in
// an unknown state. One owner now holds every timer, every in-flight background
// job and the AbortSignal handed to external requests, which makes the shutdown
// order enforceable instead of aspirational:
//
//   1. stop accepting new background work;
//   2. clear all timers;
//   3. abort in-flight external requests;
//   4. drain what is still running, under a bounded timeout;
//   5. release leases and quota reservations;
//   6. close the HTTP server;
//   7. close the database — last, so nothing can touch it afterwards.
//
// A second signal short-circuits every wait in that sequence: an operator who
// presses Ctrl+C twice, or a supervisor that follows SIGTERM with another
// signal, is asking for termination now, not for a longer grace period.

export const LIFECYCLE_STATE = Object.freeze({
  RUNNING: 'running',
  DRAINING: 'draining',
  CLOSED: 'closed',
})

// Diagnostics from a rejected promise are attacker-influenced text in the worst
// case and secret-bearing in the average one. Only the constructor name and a
// truncated single-line message are logged, never the stack.
const MAX_DIAGNOSTIC_LENGTH = 200
const CONTROL_CHARS = /\p{Cc}/gu

/** Single-line, length-capped description of an unhandled rejection reason. */
export const sanitizeDiagnostic = (reason) => {
  const name = reason instanceof Error && typeof reason.name === 'string' ? reason.name : 'Rejection'
  const raw = reason instanceof Error ? reason.message : String(reason ?? '')
  const message = raw.replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_DIAGNOSTIC_LENGTH)
  return message ? `${name}: ${message}` : name
}

/**
 * Creates the lifecycle manager.
 *
 * @param {object} [options]
 * @param {object} [options.logger] console-shaped sink.
 * @param {number} [options.drainTimeoutMs] cap on waiting for background jobs.
 * @param {number} [options.closeTimeoutMs] cap on waiting for the HTTP server.
 * @param {number} [options.releaseTimeoutMs] cap on releasing leases.
 */
export const createLifecycle = ({
  logger = console,
  drainTimeoutMs = 5_000,
  closeTimeoutMs = 10_000,
  releaseTimeoutMs = 5_000,
} = {}) => {
  const controller = new AbortController()
  const intervals = new Set()
  const timeouts = new Set()
  const inFlight = new Map()
  const stopIntakeSteps = []
  const releaseSteps = []

  let state = LIFECYCLE_STATE.RUNNING
  let closeServerStep = null
  let closeDatabaseStep = null
  let shutdownPromise = null
  let forced = false
  let databaseClosed = false
  let resolveForced = null

  // Resolves on the second shutdown request and unblocks every bounded wait.
  const forcedSignal = new Promise((resolve) => {
    resolveForced = resolve
  })

  const accepting = () => state === LIFECYCLE_STATE.RUNNING && !databaseClosed

  /** Bounded wait that also ends early when a second signal arrives. */
  const withDeadline = async (promise, timeoutMs) => {
    let timer = null
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([
        promise.then(() => 'settled'),
        deadline,
        forcedSignal.then(() => 'forced'),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Runs one background job and tracks it until it settles.
   *
   * The job receives the shared AbortSignal; anything it hands to an external
   * request is cancelled the moment shutdown begins. Rejections are logged, not
   * propagated: a failed maintenance pass must not take the process down.
   */
  const run = (name, job) => {
    if (!accepting()) return Promise.resolve({ name, skipped: true })

    const id = Symbol(name)
    const tracked = Promise.resolve()
      .then(() => job({ signal: controller.signal }))
      .then(
        (value) => {
          inFlight.delete(id)
          return { name, value }
        },
        (error) => {
          inFlight.delete(id)
          logger.error(`[lifecycle] ${name}: ${sanitizeDiagnostic(error)}`)
          return { name, failed: true }
        }
      )

    inFlight.set(id, tracked)
    return tracked
  }

  /**
   * Registers a repeating background job. The manager owns the handle, and the
   * timer is unref'd so it can never be the reason the process stays alive.
   */
  const every = (name, job, { intervalMs, firstRunDelayMs = null } = {}) => {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new TypeError(`lifecycle: ${name} requires a positive intervalMs`)
    }

    const handle = setInterval(() => {
      void run(name, job)
    }, intervalMs)
    handle.unref?.()
    intervals.add(handle)

    if (firstRunDelayMs !== null) {
      const first = setTimeout(() => {
        timeouts.delete(first)
        void run(name, job)
      }, firstRunDelayMs)
      first.unref?.()
      timeouts.add(first)
    }

    return handle
  }

  /**
   * Registers a step that stops new work from entering the process. Runs first
   * in the shutdown sequence, before timers are cleared, so nothing schedules
   * fresh database work behind the drain.
   */
  const onStopIntake = (name, step) => {
    if (typeof step !== 'function') throw new TypeError(`lifecycle: ${name} intake stop must be a function`)
    stopIntakeSteps.push({ name, step })
  }

  /** Registers a lease/reservation release step, run before the server closes. */
  const onRelease = (name, step) => {
    if (typeof step !== 'function') throw new TypeError(`lifecycle: ${name} release must be a function`)
    releaseSteps.push({ name, step })
  }

  /**
   * @param {Function} close returns a promise that settles once the HTTP server
   *   stopped serving.
   * @param {Function} [force] drops remaining connections when `close` exceeds
   *   the grace period.
   */
  const onCloseServer = (close, { force } = {}) => {
    if (typeof close !== 'function') throw new TypeError('lifecycle: server close must be a function')
    closeServerStep = { close, force }
  }

  const onCloseDatabase = (close) => {
    if (typeof close !== 'function') throw new TypeError('lifecycle: database close must be a function')
    closeDatabaseStep = close
  }

  const clearTimers = () => {
    for (const handle of intervals) clearInterval(handle)
    for (const handle of timeouts) clearTimeout(handle)
    intervals.clear()
    timeouts.clear()
  }

  const drain = async () => {
    if (!inFlight.size) return 'idle'
    const pending = Promise.all([...inFlight.values()])
    const outcome = await withDeadline(pending, drainTimeoutMs)
    if (outcome !== 'settled') {
      logger.warn(`[lifecycle] background work did not finish (${outcome}) — continuing shutdown`)
    }
    return outcome
  }

  const stopIntake = async () => {
    for (const { name, step } of stopIntakeSteps) {
      const running = Promise.resolve()
        .then(() => step())
        .catch((error) => {
          logger.error(`[lifecycle] stop intake ${name}: ${sanitizeDiagnostic(error)}`)
        })
      const outcome = await withDeadline(running, releaseTimeoutMs)
      if (outcome !== 'settled') logger.warn(`[lifecycle] stop intake ${name} did not finish (${outcome})`)
    }
  }

  const releaseAll = async () => {
    for (const { name, step } of releaseSteps) {
      const running = Promise.resolve()
        .then(() => step({ signal: controller.signal }))
        .catch((error) => {
          logger.error(`[lifecycle] release ${name}: ${sanitizeDiagnostic(error)}`)
        })
      const outcome = await withDeadline(running, releaseTimeoutMs)
      if (outcome !== 'settled') {
        logger.warn(`[lifecycle] release ${name} did not finish (${outcome})`)
      }
    }
  }

  const closeServer = async () => {
    if (!closeServerStep) return 'skipped'

    const closing = Promise.resolve()
      .then(() => closeServerStep.close())
      .catch((error) => {
        logger.error(`[lifecycle] server close: ${sanitizeDiagnostic(error)}`)
      })

    const outcome = await withDeadline(closing, closeTimeoutMs)
    if (outcome === 'settled') return 'closed'

    logger.warn('[lifecycle] open connections outlived the grace period — dropping them')
    try {
      closeServerStep.force?.()
    } catch (error) {
      logger.error(`[lifecycle] server force close: ${sanitizeDiagnostic(error)}`)
    }
    // Bounded a second time: a socket that ignores the drop must not become the
    // reason the database stays open.
    await withDeadline(closing, closeTimeoutMs)
    return 'forced'
  }

  const closeDatabase = () => {
    if (databaseClosed) return
    // Flagged BEFORE the call: from this point `run()` refuses every job, so no
    // database work can start behind the close.
    databaseClosed = true
    if (!closeDatabaseStep) return
    try {
      closeDatabaseStep()
    } catch (error) {
      logger.error(`[lifecycle] database close: ${sanitizeDiagnostic(error)}`)
    }
  }

  /**
   * Runs the shutdown sequence once. A repeated call while it is running does
   * not start a second sequence — it forces the first one to stop waiting.
   */
  const shutdown = (reason = 'shutdown') => {
    if (shutdownPromise) {
      forced = true
      resolveForced('forced')
      logger.warn(`[lifecycle] ${reason}: repeated signal — forcing termination`)
      return shutdownPromise
    }

    state = LIFECYCLE_STATE.DRAINING
    logger.log(`[lifecycle] ${reason}: stopping`)

    shutdownPromise = (async () => {
      await stopIntake()
      clearTimers()
      controller.abort(new Error(`lifecycle: ${reason}`))
      const drained = await drain()
      await releaseAll()
      const server = await closeServer()
      closeDatabase()
      state = LIFECYCLE_STATE.CLOSED
      logger.log(`[lifecycle] stopped (${reason})`)
      return Object.freeze({ reason, drained, server, forced })
    })()

    return shutdownPromise
  }

  /**
   * Wires process signals and the unhandled-rejection policy.
   *
   * An unhandled rejection means a promise chain the code no longer controls;
   * continuing to serve requests on that state is how a half-committed
   * transaction becomes a permanent inconsistency. The process writes a
   * sanitized diagnostic, shuts down gracefully and exits non-zero, so the
   * supervisor replaces it with a clean one.
   */
  const attachProcessSignals = ({
    target = process,
    signals = ['SIGTERM', 'SIGINT'],
    exit = (code) => target.exit(code),
  } = {}) => {
    for (const signal of signals) {
      target.on(signal, () => {
        const repeated = Boolean(shutdownPromise)
        const done = shutdown(signal)
        // A repeated signal is a request to stop now: once the sequence has
        // unwound we leave with a non-zero code rather than waiting for the
        // event loop to drain on its own.
        if (repeated) done.then(() => exit(1), () => exit(1))
      })
    }

    target.on('unhandledRejection', (reason) => {
      logger.error(`[lifecycle] unhandled rejection: ${sanitizeDiagnostic(reason)}`)
      shutdown('unhandledRejection').then(() => exit(1), () => exit(1))
    })

    target.on('uncaughtException', (error) => {
      logger.error(`[lifecycle] uncaught exception: ${sanitizeDiagnostic(error)}`)
      shutdown('uncaughtException').then(() => exit(1), () => exit(1))
    })
  }

  return {
    signal: controller.signal,
    accepting,
    run,
    every,
    onStopIntake,
    onRelease,
    onCloseServer,
    onCloseDatabase,
    shutdown,
    attachProcessSignals,
    state: () => state,
    isDatabaseClosed: () => databaseClosed,
    timerCount: () => intervals.size + timeouts.size,
    inFlightCount: () => inFlight.size,
  }
}
