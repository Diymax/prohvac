// CR-055: the request-deduplication rules of the admin session.
//
// The coordinator is exported from useSession.js precisely so these rules can
// be tested without a DOM: vitest runs in node here and jsdom is not a project
// dependency, so the hook itself cannot be rendered.

import { describe, expect, it, vi } from 'vitest'

import { createSessionSync } from './useSession.js'

/** Promise that is resolved from the outside, to hold a request in flight. */
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Clock the coordinator can be driven with instead of Date.now(). */
const clock = (start = 0) => {
  let value = start
  return { now: () => value, advance: (ms) => { value += ms } }
}

describe('session request coordinator', () => {
  it('collapses focus and visibilitychange into one request', async () => {
    const sync = createSessionSync()
    const gate = deferred()
    const task = vi.fn(() => gate.promise)

    const first = sync.refresh(task, { force: true })
    const second = sync.refresh(task, { force: true })

    expect(task).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(sync.pending).toBe(true)

    gate.resolve('done')
    await first
    expect(sync.pending).toBe(false)
  })

  it('keeps quiet between refreshes and obeys force', async () => {
    const time = clock(10_000)
    const sync = createSessionSync({ now: time.now, minIntervalMs: 30_000 })
    const task = vi.fn(async () => 'ok')

    await sync.refresh(task)
    expect(task).toHaveBeenCalledTimes(1)

    time.advance(1_000)
    await sync.refresh(task)
    expect(task).toHaveBeenCalledTimes(1)

    // A returning network connection cannot wait for the interval.
    await sync.refresh(task, { force: true })
    expect(task).toHaveBeenCalledTimes(2)

    time.advance(30_000)
    await sync.refresh(task)
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('does not spend a ticket on a throttled call', async () => {
    const time = clock()
    const sync = createSessionSync({ now: time.now, minIntervalMs: 30_000 })
    await sync.refresh(async (ticket) => expect(ticket).toBe(1))
    await sync.refresh(async () => expect.unreachable('throttled call must not run'))
    expect(sync.ticket()).toBe(2)
  })

  it('lets a newer operation win over a slow older response', async () => {
    const sync = createSessionSync()

    // A refresh starts first, a sign-in is issued while it is still in flight.
    const refreshTicket = sync.ticket()
    const loginTicket = sync.ticket()

    expect(sync.commit(loginTicket)).toBe(true)
    // The slow refresh answers last and must not roll the session — nor its
    // CSRF token — back to the anonymous state it saw.
    expect(sync.accepts(refreshTicket)).toBe(false)
    expect(sync.commit(refreshTicket)).toBe(false)
  })

  it('lets a sign-in override a refresh that started later', () => {
    const sync = createSessionSync()

    // The refresh takes its number when it is sent: its answer describes the
    // server as it was before the sign-in.
    const refreshTicket = sync.ticket()
    // The sign-in takes its number when its answer arrives, so it establishes
    // the newest state even against a query that was sent after it.
    expect(sync.commit(refreshTicket)).toBe(true)
    const loginTicket = sync.ticket()
    expect(sync.commit(loginTicket)).toBe(true)
  })

  it('applies an older response when nothing newer has landed', () => {
    const sync = createSessionSync()
    const first = sync.ticket()
    sync.ticket()
    expect(sync.commit(first)).toBe(true)
  })

  it('refuses a second commit of the same operation', () => {
    const sync = createSessionSync()
    const ticket = sync.ticket()
    expect(sync.commit(ticket)).toBe(true)
    expect(sync.commit(ticket)).toBe(false)
  })

  it('stops accepting anything after unmount', async () => {
    const sync = createSessionSync()
    const ticket = sync.ticket()
    const task = vi.fn(async () => 'ok')

    sync.dispose()

    expect(sync.disposed).toBe(true)
    expect(sync.ticket()).toBe(0)
    expect(sync.accepts(ticket)).toBe(false)
    expect(sync.commit(ticket)).toBe(false)
    await expect(sync.refresh(task, { force: true })).resolves.toBeNull()
    expect(task).not.toHaveBeenCalled()
  })

  it('drops an in-flight response that arrives after unmount', async () => {
    const sync = createSessionSync()
    const gate = deferred()
    let seen = 0

    const promise = sync.refresh(async (ticket) => {
      await gate.promise
      if (sync.commit(ticket)) seen += 1
    }, { force: true })

    sync.dispose()
    gate.resolve()
    await promise
    expect(seen).toBe(0)
  })

  it('reopens for a new request after a failed one', async () => {
    const sync = createSessionSync({ minIntervalMs: 0 })
    const failing = vi.fn(async () => {
      throw new Error('network down')
    })

    await expect(sync.refresh(failing, { force: true })).rejects.toThrow('network down')
    expect(sync.pending).toBe(false)

    // Reconnect: the coordinator must not stay latched on the failure.
    const task = vi.fn(async () => 'ok')
    await sync.refresh(task, { force: true })
    expect(task).toHaveBeenCalledTimes(1)
  })
})
