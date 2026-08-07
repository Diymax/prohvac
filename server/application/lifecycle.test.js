// CR-038. The scenario behind this module: SIGTERM arrives in the middle of a
// translation tick. Before the manager existed, the timers were anonymous
// `setInterval` handles, the provider request kept running, the lease stayed
// held and `closeDb()` could land while a background job was still writing.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createLifecycle, LIFECYCLE_STATE, sanitizeDiagnostic } from './lifecycle.js'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

/** Timer that never keeps the test runner alive. */
const after = (ms, value) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms)
    timer.unref?.()
  })

/**
 * Lifecycle wired so every shutdown step appends to one ordered log. The order
 * is the whole contract of this module, so it is asserted directly.
 */
const createHarness = (options = {}) => {
  const events = []
  const lifecycle = createLifecycle({
    logger: silentLogger,
    drainTimeoutMs: 200,
    closeTimeoutMs: 200,
    releaseTimeoutMs: 200,
    ...options,
  })

  lifecycle.onStopIntake('runtime', () => events.push('stop-intake'))
  lifecycle.onRelease('translate', async () => {
    events.push('release')
  })
  lifecycle.onCloseServer(
    async () => {
      events.push('close-server')
    },
    { force: () => events.push('force-connections') }
  )
  lifecycle.onCloseDatabase(() => events.push('close-db'))

  return { lifecycle, events }
}

describe('lifecycle shutdown order', () => {
  it('stops intake, drains, releases leases, closes the server and only then the database', async () => {
    const { lifecycle, events } = createHarness()

    lifecycle.run('tick', async () => {
      await after(20)
      events.push('tick-finished')
    })

    const result = await lifecycle.shutdown('SIGTERM')

    expect(events).toEqual([
      'stop-intake',
      'tick-finished',
      'release',
      'close-server',
      'close-db',
    ])
    expect(result).toMatchObject({ reason: 'SIGTERM', drained: 'settled', forced: false })
    expect(lifecycle.state()).toBe(LIFECYCLE_STATE.CLOSED)
  })

  it('aborts external requests before waiting for background work', async () => {
    const { lifecycle, events } = createHarness()
    const seen = []

    lifecycle.run('tick', async ({ signal }) => {
      signal.addEventListener('abort', () => seen.push('aborted'), { once: true })
      await after(20)
      events.push('tick-finished')
    })

    await lifecycle.shutdown('SIGTERM')
    expect(seen).toEqual(['aborted'])
    expect(lifecycle.signal.aborted).toBe(true)
  })

  it('runs no database operation after the database is closed', async () => {
    const { lifecycle, events } = createHarness()
    const late = vi.fn(async () => events.push('late-write'))

    await lifecycle.shutdown('SIGTERM')

    const outcome = await lifecycle.run('late', late)
    expect(late).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ skipped: true })
    expect(lifecycle.isDatabaseClosed()).toBe(true)
    expect(events).not.toContain('late-write')
    expect(events.indexOf('close-db')).toBe(events.length - 1)
  })

  it('gives up on background work that outlives the drain timeout', async () => {
    const { lifecycle, events } = createHarness({ drainTimeoutMs: 30 })

    lifecycle.run('stuck', () => after(5_000))
    const result = await lifecycle.shutdown('SIGTERM')

    expect(result.drained).toBe('timeout')
    expect(events).toContain('close-db')
  })

  it('drops connections the HTTP server could not close in time', async () => {
    const { lifecycle, events } = createHarness({ closeTimeoutMs: 30 })
    let resolveClose
    lifecycle.onCloseServer(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve
        }),
      {
        force: () => {
          events.push('force-connections')
          resolveClose()
        },
      }
    )

    const result = await lifecycle.shutdown('SIGTERM')
    expect(result.server).toBe('forced')
    expect(events).toEqual(['stop-intake', 'release', 'force-connections', 'close-db'])
  })
})

describe('lifecycle timers', () => {
  it('never lets a background timer keep the process alive', () => {
    const { lifecycle } = createHarness()
    const handle = lifecycle.every('tick', async () => {}, {
      intervalMs: 60_000,
      firstRunDelayMs: 5_000,
    })

    expect(handle.hasRef()).toBe(false)
    expect(lifecycle.timerCount()).toBe(2)
  })

  it('clears every timer it owns on shutdown', async () => {
    const { lifecycle } = createHarness()
    const job = vi.fn(async () => {})
    lifecycle.every('tick', job, { intervalMs: 10, firstRunDelayMs: 10 })
    lifecycle.every('maintenance', job, { intervalMs: 10 })

    await lifecycle.shutdown('SIGTERM')
    const callsAtShutdown = job.mock.calls.length

    await after(60)
    expect(lifecycle.timerCount()).toBe(0)
    expect(job.mock.calls.length).toBe(callsAtShutdown)
  })

  it('refuses an interval without a positive period', () => {
    const { lifecycle } = createHarness()
    expect(() => lifecycle.every('tick', () => {}, { intervalMs: 0 })).toThrow(TypeError)
  })

  it('keeps a failing job from taking the process down', async () => {
    const errors = []
    const lifecycle = createLifecycle({
      logger: { ...silentLogger, error: (message) => errors.push(message) },
    })

    const outcome = await lifecycle.run('tick', async () => {
      throw new Error('provider unreachable')
    })

    expect(outcome).toMatchObject({ name: 'tick', failed: true })
    expect(errors[0]).toContain('provider unreachable')
  })
})

describe('lifecycle repeated signal', () => {
  it('stops waiting as soon as a second signal arrives', async () => {
    const { lifecycle } = createHarness({ drainTimeoutMs: 5_000 })
    lifecycle.run('stuck', () => after(10_000))

    const startedAt = Date.now()
    const first = lifecycle.shutdown('SIGTERM')
    const second = lifecycle.shutdown('SIGTERM')

    expect(second).toBe(first)
    const result = await first
    expect(result.forced).toBe(true)
    expect(result.drained).toBe('forced')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('runs the sequence once even when the signal repeats', async () => {
    const { lifecycle, events } = createHarness()

    await Promise.all([lifecycle.shutdown('SIGTERM'), lifecycle.shutdown('SIGINT')])
    await lifecycle.shutdown('SIGTERM')

    expect(events.filter((event) => event === 'close-db')).toHaveLength(1)
  })
})

describe('lifecycle process integration', () => {
  const attach = (options = {}) => {
    const target = new EventEmitter()
    const exit = vi.fn()
    const logs = []
    const lifecycle = createLifecycle({
      logger: { log: () => {}, warn: () => {}, error: (message) => logs.push(message) },
      drainTimeoutMs: 50,
      closeTimeoutMs: 50,
      releaseTimeoutMs: 50,
      ...options,
    })
    const closed = []
    lifecycle.onCloseDatabase(() => closed.push('db'))
    lifecycle.attachProcessSignals({ target, exit })
    return { target, exit, lifecycle, logs, closed }
  }

  it('shuts down gracefully and exits non-zero on an unhandled rejection', async () => {
    const { target, exit, lifecycle, logs, closed } = attach()

    target.emit('unhandledRejection', new Error('lead delivery promise was dropped'))
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

    expect(lifecycle.state()).toBe(LIFECYCLE_STATE.CLOSED)
    expect(closed).toEqual(['db'])
    expect(logs.some((line) => line.includes('lead delivery promise was dropped'))).toBe(true)
  })

  it('shuts down without an exit code on the first termination signal', async () => {
    const { target, exit, lifecycle } = attach()

    target.emit('SIGTERM')
    await vi.waitFor(() => expect(lifecycle.state()).toBe(LIFECYCLE_STATE.CLOSED))
    expect(exit).not.toHaveBeenCalled()
  })

  it('exits non-zero when the termination signal repeats', async () => {
    const { target, exit } = attach()

    target.emit('SIGTERM')
    target.emit('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  })
})

describe('unhandled rejection diagnostics', () => {
  it('reports the error class and message without a stack', () => {
    const error = new TypeError('translator.tick is not a function')
    expect(sanitizeDiagnostic(error)).toBe('TypeError: translator.tick is not a function')
    expect(sanitizeDiagnostic(error)).not.toContain('at ')
  })

  it('collapses control characters that would forge log lines', () => {
    const forged = new Error('boom\r\n[boot] всё хорошо')
    expect(sanitizeDiagnostic(forged)).toBe('Error: boom  [boot] всё хорошо')
  })

  it('caps the length of an attacker-influenced message', () => {
    const long = new Error('x'.repeat(5_000))
    expect(sanitizeDiagnostic(long).length).toBeLessThanOrEqual(210)
  })

  it('describes a non-error rejection reason', () => {
    expect(sanitizeDiagnostic('just a string')).toBe('Rejection: just a string')
    expect(sanitizeDiagnostic(undefined)).toBe('Rejection')
  })
})
