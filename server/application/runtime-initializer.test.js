// CR-010 / CR-042. The scenario behind this module: the first request after a
// restart opens the database, runs migrations and registers every route. That
// attempt can fail, and the two failure modes it used to have were both fatal —
// a half-registered router, or a process parked in `failed` until somebody
// restarted the pool by hand.

import { describe, expect, it, vi } from 'vitest'

import {
  createRuntimeInitializer,
  classifyInitializationError,
  ERROR_CLASS,
  INITIALIZATION_STATE,
} from './runtime-initializer.js'

/** Controllable clock: backoff assertions must not depend on wall time. */
const createClock = (start = 1_000_000) => {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
      return current
    },
    at: () => current,
  }
}

// random() === 0.5 puts the symmetric jitter exactly at zero, so the delay is
// the nominal backoff step and the assertions stay exact.
const noJitter = () => 0.5

const transient = (message = 'disk is busy') => Object.assign(new Error(message), { code: 'EBUSY' })
const permanent = (message = 'data directory is not writable') =>
  Object.assign(new Error(message), { code: 'EACCES' })

describe('runtime initializer', () => {
  it('shares one initialization promise across parallel callers', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const initialize = vi.fn(async () => gate)
    const runtime = createRuntimeInitializer({ initialize })

    const first = runtime.ensure()
    const second = runtime.ensure()
    const third = runtime.ensure()
    await Promise.resolve()
    expect(runtime.status()).toMatchObject({
      state: INITIALIZATION_STATE.INITIALIZING,
      attempts: 1,
    })
    expect(initialize).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second, third])
    expect(runtime.status()).toMatchObject({
      state: INITIALIZATION_STATE.READY,
      ready: true,
      attempts: 1,
      failures: 0,
    })
  })

  it('never initializes twice once ready, so routes are registered exactly once', async () => {
    const registrations = []
    const initialize = vi.fn(async ({ attempt }) => {
      registrations.push(attempt)
    })
    const runtime = createRuntimeInitializer({ initialize })

    await Promise.all([runtime.ensure(), runtime.ensure(), runtime.ensure()])
    await runtime.ensure()
    await runtime.ensure()

    expect(registrations).toEqual([1])
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('does not register routes twice when the first attempt failed mid-way', async () => {
    const clock = createClock()
    const registrations = []
    const initialize = vi.fn(async ({ attempt }) => {
      registrations.push(attempt)
      if (attempt === 1) throw transient('migration interrupted')
    })
    const runtime = createRuntimeInitializer({
      initialize,
      now: clock.now,
      random: noJitter,
      baseDelayMs: 500,
    })

    await expect(runtime.ensure()).rejects.toThrow('migration interrupted')
    clock.advance(500)
    await expect(runtime.ensure()).resolves.toBeUndefined()
    await runtime.ensure()

    expect(registrations).toEqual([1, 2])
  })

  it('refuses a retry until the backoff has elapsed', async () => {
    const clock = createClock()
    const initialize = vi.fn(async () => {
      throw transient()
    })
    const runtime = createRuntimeInitializer({
      initialize,
      now: clock.now,
      random: noJitter,
      baseDelayMs: 500,
    })

    await expect(runtime.ensure()).rejects.toThrow('disk is busy')
    expect(runtime.status().nextRetryAt).toBe(clock.at() + 500)

    clock.advance(499)
    await expect(runtime.ensure()).rejects.toThrow('disk is busy')
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(runtime.status().retryAfterMs).toBe(1)

    clock.advance(1)
    await expect(runtime.ensure()).rejects.toThrow('disk is busy')
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it('grows the backoff exponentially up to the ceiling', async () => {
    const clock = createClock()
    const initialize = vi.fn(async () => {
      throw transient()
    })
    const runtime = createRuntimeInitializer({
      initialize,
      now: clock.now,
      random: noJitter,
      baseDelayMs: 500,
      maxDelayMs: 2_000,
    })

    const delays = []
    for (let i = 0; i < 5; i += 1) {
      await expect(runtime.ensure()).rejects.toThrow('disk is busy')
      delays.push(runtime.status().nextRetryAt - clock.at())
      clock.advance(delays.at(-1))
    }

    expect(delays).toEqual([500, 1_000, 2_000, 2_000, 2_000])
    expect(initialize).toHaveBeenCalledTimes(5)
  })

  it('spreads retries with jitter so pool processes do not retry in lockstep', async () => {
    const clock = createClock()
    const initialize = async () => {
      throw transient()
    }
    const delayWith = async (random) => {
      const runtime = createRuntimeInitializer({
        initialize,
        now: clock.now,
        random,
        baseDelayMs: 1_000,
        jitterRatio: 0.2,
      })
      await expect(runtime.ensure()).rejects.toThrow()
      return runtime.status().nextRetryAt - clock.at()
    }

    expect(await delayWith(() => 0)).toBe(800)
    expect(await delayWith(() => 1)).toBe(1_200)
    expect(await delayWith(noJitter)).toBe(1_000)
  })

  it('applies the cooldown floor to every retry delay', async () => {
    const clock = createClock()
    const runtime = createRuntimeInitializer({
      initialize: async () => {
        throw transient()
      },
      now: clock.now,
      random: noJitter,
      baseDelayMs: 1,
      cooldownMs: 250,
    })

    await expect(runtime.ensure()).rejects.toThrow()
    expect(runtime.status().nextRetryAt - clock.at()).toBe(250)
  })

  it('separates a permanent configuration error from a transient one', async () => {
    const clock = createClock()
    const build = (error) =>
      createRuntimeInitializer({
        initialize: async () => {
          throw error
        },
        now: clock.now,
        random: noJitter,
        baseDelayMs: 500,
        permanentDelayMs: 60_000,
      })

    const broken = build(permanent())
    await expect(broken.ensure()).rejects.toThrow()
    expect(broken.status()).toMatchObject({
      state: INITIALIZATION_STATE.DEGRADED,
      errorClass: ERROR_CLASS.CONFIGURATION,
      errorCode: 'EACCES',
      permanent: true,
    })
    expect(broken.status().nextRetryAt - clock.at()).toBe(60_000)

    const busy = build(transient())
    await expect(busy.ensure()).rejects.toThrow()
    expect(busy.status()).toMatchObject({
      state: INITIALIZATION_STATE.FAILED_TEMPORARILY,
      errorClass: ERROR_CLASS.INFRASTRUCTURE,
      errorCode: 'EBUSY',
      permanent: false,
    })
    expect(busy.status().nextRetryAt - clock.at()).toBe(500)
  })

  it('retries a permanent error too, so a fixed configuration needs no restart', async () => {
    const clock = createClock()
    let broken = true
    const initialize = vi.fn(async () => {
      if (broken) throw permanent()
    })
    const runtime = createRuntimeInitializer({
      initialize,
      now: clock.now,
      random: noJitter,
      permanentDelayMs: 60_000,
    })

    await expect(runtime.ensure()).rejects.toThrow()
    expect(runtime.status().state).toBe(INITIALIZATION_STATE.DEGRADED)

    broken = false
    clock.advance(60_000)
    await expect(runtime.ensure()).resolves.toBeUndefined()
    expect(runtime.status()).toMatchObject({
      state: INITIALIZATION_STATE.READY,
      failures: 0,
      errorClass: null,
      nextRetryAt: null,
    })
  })

  it('keeps error messages out of the health status', async () => {
    const clock = createClock()
    const secretish = Object.assign(
      new Error('unable to open /srv/prohvac/data/app.sqlite (token=abc123)'),
      { code: 'SQLITE_CANTOPEN' }
    )
    const runtime = createRuntimeInitializer({
      initialize: async () => {
        throw secretish
      },
      now: clock.now,
      random: noJitter,
    })

    await expect(runtime.ensure()).rejects.toThrow()
    const status = runtime.status()

    expect(JSON.stringify(status)).not.toContain('app.sqlite')
    expect(JSON.stringify(status)).not.toContain('abc123')
    expect(status).toMatchObject({
      errorCode: 'SQLITE_CANTOPEN',
      errorName: 'Error',
      errorClass: ERROR_CLASS.INFRASTRUCTURE,
    })
    expect(status.nextRetryAt).toBeGreaterThan(clock.at())
  })

  it('reports a failure once per attempt, not once per waiting caller', async () => {
    const clock = createClock()
    const onFailure = vi.fn()
    const runtime = createRuntimeInitializer({
      initialize: async () => {
        throw transient()
      },
      now: clock.now,
      random: noJitter,
      onFailure,
    })

    const attempts = [runtime.ensure(), runtime.ensure(), runtime.ensure()]
    await Promise.allSettled(attempts)

    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      failures: 1,
      errorClass: ERROR_CLASS.INFRASTRUCTURE,
      errorCode: 'EBUSY',
    })
  })

  it('stops attempting once shutdown started', async () => {
    const initialize = vi.fn(async () => {})
    const runtime = createRuntimeInitializer({ initialize })

    await runtime.shutdown()
    await expect(runtime.ensure()).rejects.toThrow(/shutting down/)
    expect(initialize).not.toHaveBeenCalled()
    expect(runtime.status()).toMatchObject({
      state: INITIALIZATION_STATE.SHUTTING_DOWN,
      canRetry: false,
    })
  })

  it('does not publish ready when shutdown overtakes an in-flight attempt', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const runtime = createRuntimeInitializer({ initialize: async () => gate })

    const pending = runtime.ensure()
    const stopped = runtime.shutdown()
    release()
    await Promise.all([pending, stopped])

    expect(runtime.isReady()).toBe(false)
    expect(runtime.status().state).toBe(INITIALIZATION_STATE.SHUTTING_DOWN)
  })

  it('rejects an unusable configuration instead of silently defaulting', () => {
    expect(() => createRuntimeInitializer({})).toThrow(TypeError)
    expect(() => createRuntimeInitializer({ initialize: () => {}, baseDelayMs: -1 })).toThrow(TypeError)
    expect(() => createRuntimeInitializer({ initialize: () => {}, jitterRatio: 1 })).toThrow(TypeError)
    expect(() => createRuntimeInitializer({ initialize: () => {}, onFailure: 'nope' })).toThrow(TypeError)
  })
})

describe('initialization error classification', () => {
  it.each([
    ['permission denied', Object.assign(new Error('x'), { code: 'EACCES' }), ERROR_CLASS.CONFIGURATION],
    ['read-only file system', Object.assign(new Error('x'), { code: 'EROFS' }), ERROR_CLASS.CONFIGURATION],
    ['not a database', Object.assign(new Error('x'), { code: 'SQLITE_NOTADB' }), ERROR_CLASS.CONFIGURATION],
    ['programming mistake', new TypeError('x'), ERROR_CLASS.CONFIGURATION],
    ['locked database', Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }), ERROR_CLASS.INFRASTRUCTURE],
    ['missing directory', Object.assign(new Error('x'), { code: 'ENOENT' }), ERROR_CLASS.INFRASTRUCTURE],
    ['unknown failure', new Error('x'), ERROR_CLASS.INFRASTRUCTURE],
  ])('classifies %s', (_name, error, expected) => {
    expect(classifyInitializationError(error)).toBe(expected)
  })

  it('follows the cause chain that wraps a low-level failure', () => {
    const wrapped = new Error('could not create the data directory', {
      cause: Object.assign(new Error('denied'), { code: 'EACCES' }),
    })
    expect(classifyInitializationError(wrapped)).toBe(ERROR_CLASS.CONFIGURATION)
  })

  it('does not loop on a self-referencing cause', () => {
    const looping = new Error('loop')
    looping.cause = looping
    expect(classifyInitializationError(looping)).toBe(ERROR_CLASS.INFRASTRUCTURE)
  })
})
