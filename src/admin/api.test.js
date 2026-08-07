// CR-055: the parts of the admin HTTP client that decide what happens when
// several requests are in flight at once — CSRF token rotation, the
// session-lost announcement and cancellation.
//
// fetch is stubbed on globalThis; no DOM is involved, which is what makes
// these tests possible in this project (vitest runs in node).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  api,
  getCsrfGeneration,
  getCsrfToken,
  request,
  setCsrfToken,
  setSessionLostHandler,
} from './api.js'

const jsonResponse = (body, { status = 200, ok, headers = {} } = {}) => ({
  status,
  ok: ok ?? status < 400,
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  json: async () => body,
})

const htmlResponse = (status = 200) => ({
  status,
  ok: status < 400,
  headers: new Headers({ 'content-type': 'text/html' }),
  json: async () => null,
})

/** Response held back until the returned release() is called. */
const pendingResponse = () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  return { gate, release }
}

let fetchMock

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  setCsrfToken('')
  setSessionLostHandler(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken('')
  setSessionLostHandler(null)
})

describe('csrf token', () => {
  it('rotates with a growing generation', () => {
    const first = setCsrfToken('token-1')
    expect(getCsrfToken()).toBe('token-1')

    const second = setCsrfToken('token-2')
    expect(getCsrfToken()).toBe('token-2')
    expect(second).toBeGreaterThan(first)
    expect(getCsrfGeneration()).toBe(second)
  })

  it('travels with unsafe methods only', async () => {
    setCsrfToken('token-1')
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    await api.get('/session')
    expect(fetchMock.mock.calls[0][1].headers['X-CSRF-Token']).toBeUndefined()

    await api.post('/session', { username: 'u' })
    expect(fetchMock.mock.calls[1][1].headers['X-CSRF-Token']).toBe('token-1')
  })

  it('sends the token that was current when the request was built', async () => {
    setCsrfToken('token-1')
    const slow = pendingResponse()
    fetchMock.mockImplementationOnce(async () => {
      await slow.gate
      return jsonResponse({ ok: true })
    })

    const inFlight = api.post('/entities', { name: 'x' })
    // A parallel login answers and rotates the token mid-flight.
    setCsrfToken('token-2')
    slow.release()
    await inFlight

    expect(fetchMock.mock.calls[0][1].headers['X-CSRF-Token']).toBe('token-1')
    expect(getCsrfToken()).toBe('token-2')
  })

  it('rearms the session-lost announcement when a new session starts', async () => {
    const onLost = vi.fn()
    setSessionLostHandler(onLost)
    fetchMock.mockResolvedValue(htmlResponse())

    await expect(api.get('/session')).rejects.toBeInstanceOf(ApiError)
    expect(onLost).toHaveBeenCalledTimes(1)

    setCsrfToken('token-after-login')
    await expect(api.get('/session')).rejects.toBeInstanceOf(ApiError)
    expect(onLost).toHaveBeenCalledTimes(2)
  })
})

describe('session lost', () => {
  it('is announced once no matter how many requests hit the expired cookie', async () => {
    const onLost = vi.fn()
    setSessionLostHandler(onLost)
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'no_session' }, { status: 401 }))

    const results = await Promise.allSettled([
      api.get('/leads'),
      api.get('/media'),
      api.get('/settings'),
    ])

    expect(results.every((item) => item.status === 'rejected')).toBe(true)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('is announced for the uniform 404 disguise as well', async () => {
    const onLost = vi.fn()
    setSessionLostHandler(onLost)
    fetchMock.mockResolvedValue(htmlResponse())

    await expect(api.get('/session')).rejects.toMatchObject({ code: 'not_found' })
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes only its own handler', async () => {
    const first = vi.fn()
    const second = vi.fn()

    const unsubscribeFirst = setSessionLostHandler(first)
    setSessionLostHandler(second)
    // The old hook instance unmounts after a new one has registered.
    unsubscribeFirst()

    fetchMock.mockResolvedValue(htmlResponse())
    await expect(api.get('/session')).rejects.toBeInstanceOf(ApiError)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stays silent after its handler is removed', async () => {
    const handler = vi.fn()
    const unsubscribe = setSessionLostHandler(handler)
    unsubscribe()

    fetchMock.mockResolvedValue(htmlResponse())
    await expect(api.get('/session')).rejects.toBeInstanceOf(ApiError)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('cancellation', () => {
  it('reports an external abort as AbortError, not as a network failure', async () => {
    fetchMock.mockImplementation(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    const controller = new AbortController()
    const inFlight = request('GET', '/session', { signal: controller.signal })
    controller.abort()

    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not announce a session loss for a cancelled request', async () => {
    const onLost = vi.fn()
    setSessionLostHandler(onLost)
    fetchMock.mockImplementation(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    const controller = new AbortController()
    const inFlight = request('GET', '/session', { signal: controller.signal })
    controller.abort()

    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })
    expect(onLost).not.toHaveBeenCalled()
  })

  it('turns its own timeout into a timeout error', async () => {
    fetchMock.mockImplementation(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        })
    )

    await expect(request('GET', '/session', { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'timeout',
    })
  })
})
