import { afterEach, describe, expect, it, vi } from 'vitest'

import { createContentStore } from './public.content.js'

afterEach(() => vi.restoreAllMocks())

const fakeDb = () => {
  const state = { generation: '1', failGeneration: false }
  return {
    state,
    get: vi.fn(() => {
      if (state.failGeneration) throw new Error('sqlite unavailable')
      return { value: state.generation }
    }),
  }
}

describe('public content degraded cache policy', () => {
  it('caches a successful read, including a genuinely empty result', async () => {
    const db = fakeDb()
    const store = createContentStore(db, { generationTtlMs: 0 })
    const emptyBody = Buffer.from('{"projects":[]}')
    const build = vi.fn(async () => ({ ok: true, body: emptyBody, empty: true }))

    const first = await store.entryFor('site', build)
    const second = await store.entryFor('site', build)

    expect(first.body).toEqual(emptyBody)
    expect(first.degraded).toBeUndefined()
    expect(second).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('serves the last valid cache entry when a new revision cannot be read', async () => {
    const db = fakeDb()
    const store = createContentStore(db, { generationTtlMs: 0 })
    const original = await store.entryFor('site', async () => ({
      ok: true,
      body: Buffer.from('{"revision":1}'),
    }))

    db.state.generation = '2'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const degraded = await store.entryFor('site', async () => ({ ok: false, body: null }))

    expect(degraded.body).toEqual(original.body)
    expect(degraded.etag).toBe(original.etag)
    expect(degraded.degraded).toBe(true)
    expect(error).toHaveBeenCalled()
  })

  it('uses an uncached fallback only when no prior valid entry exists', async () => {
    const db = fakeDb()
    const store = createContentStore(db, { generationTtlMs: 0 })
    const fallback = vi.fn(async () => Buffer.from('{"fallback":true}'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const degraded = await store.entryFor(
      'site',
      async () => ({ ok: false, body: null }),
      { fallback }
    )
    const recovered = await store.entryFor(
      'site',
      async () => ({ ok: true, body: Buffer.from('{"database":true}') }),
      { fallback }
    )

    expect(degraded).toMatchObject({ generation: 'fallback', degraded: true })
    expect(recovered.body.toString()).toBe('{"database":true}')
    expect(recovered.generation).toBe('1')
    expect(recovered.degraded).toBeUndefined()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
  })

  it('does not create a fallback revision when generation lookup fails', async () => {
    const db = fakeDb()
    const store = createContentStore(db, { generationTtlMs: 0 })
    const valid = await store.entryFor('locale:ru', async () => ({
      ok: true,
      body: Buffer.from('{"ok":true}'),
    }))
    db.state.failGeneration = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const degraded = await store.entryFor(
      'locale:ru',
      async () => ({ ok: true, body: Buffer.from('{"wrong":true}') }),
      { fallback: async () => Buffer.from('{"fallback":true}') }
    )

    expect(degraded.body).toEqual(valid.body)
    expect(degraded.generation).toBe(valid.generation)
    expect(degraded.degraded).toBe(true)
    expect(error).toHaveBeenCalled()
  })
})
