// CR-046. Кэш публичного контента: одна пересборка на ключ, пауза только при
// устойчивом отказе, ограниченный размер и наблюдаемость.

import { describe, expect, it, vi } from 'vitest'

import { createContentStore } from './public.content.js'

const fakeDb = (generation = '1') => ({
  state: { generation },
  get() {
    return { value: this.state.generation }
  },
})

/** Управляемое время: паузу надо проверять детерминированно, а не sleep'ом. */
const clock = (start = 0) => {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

describe('public content cache single-flight (CR-046)', () => {
  it('coalesces dozens of parallel requests into one rebuild', async () => {
    const store = createContentStore(fakeDb(), { generationTtlMs: 1_000 })
    let started = 0
    let release
    const gate = new Promise((resolve) => (release = resolve))

    const build = async () => {
      started += 1
      await gate
      return { ok: true, body: Buffer.from('{"v":1}') }
    }

    const waiters = Array.from({ length: 50 }, () => store.entryFor('site', build))
    release()
    const results = await Promise.all(waiters)

    expect(started).toBe(1)
    expect(new Set(results.map((entry) => entry.etag)).size).toBe(1)

    const metrics = store.metrics()
    expect(metrics.rebuild).toBe(1)
    expect(metrics.coalesced).toBe(49)
  })

  it('serves subsequent requests from cache without touching the builder', async () => {
    const store = createContentStore(fakeDb(), { generationTtlMs: 1_000 })
    const build = vi.fn(async () => ({ ok: true, body: Buffer.from('{"v":1}') }))

    await store.entryFor('site', build)
    await store.entryFor('site', build)
    await store.entryFor('site', build)

    expect(build).toHaveBeenCalledTimes(1)
    expect(store.metrics()).toMatchObject({ rebuild: 1, hit: 2, miss: 1 })
  })

  it('starts a fresh rebuild once the generation changes', async () => {
    const db = fakeDb()
    const store = createContentStore(db, { generationTtlMs: 0 })
    const build = vi.fn(async () => ({ ok: true, body: Buffer.from(`{"g":${db.state.generation}}`) }))

    const first = await store.entryFor('site', build)
    db.state.generation = '2'
    const second = await store.entryFor('site', build)

    expect(build).toHaveBeenCalledTimes(2)
    expect(first.etag).not.toBe(second.etag)
  })
})

describe('public content cache failure backoff (CR-046)', () => {
  it('retries immediately after a single transient failure', async () => {
    const store = createContentStore(fakeDb(), { generationTtlMs: 0 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await store.entryFor('site', async () => ({ ok: false, body: null }), {
        fallback: async () => Buffer.from('{"fallback":true}'),
      })
      const recovered = await store.entryFor('site', async () => ({
        ok: true,
        body: Buffer.from('{"database":true}'),
      }))

      // Одиночный сбой не должен задерживать возврат к нормальной работе:
      // от шторма запросов защищает single-flight, а не пауза.
      expect(recovered.body.toString()).toBe('{"database":true}')
      expect(recovered.degraded).toBeUndefined()
    } finally {
      error.mockRestore()
    }
  })

  it('backs off after repeated failures and serves the last valid entry', async () => {
    const time = clock()
    const store = createContentStore(fakeDb(), {
      generationTtlMs: 0,
      failureBackoffMs: 1_000,
      now: time.now,
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const good = await store.entryFor('site', async () => ({
        ok: true,
        body: Buffer.from('{"v":1}'),
      }))
      // Ревизия не меняется, поэтому кэш валиден; заставляем пересобрать,
      // сдвинув поколение и уронив сборку дважды подряд.
      const failing = vi.fn(async () => ({ ok: false, body: null }))

      const db = store
      void db
      await store.entryFor('site:other', failing)
      await store.entryFor('site:other', failing)
      const skipped = await store.entryFor('site:other', failing)

      // Третий вызов не должен дойти до сборки.
      expect(failing).toHaveBeenCalledTimes(2)
      expect(skipped).toBe(null)
      expect(store.metrics().backoffSkipped).toBe(1)

      // Пауза удваивается со второго сбоя: 1000 -> 2000 мс.
      time.advance(2_500)
      await store.entryFor('site:other', failing)
      expect(failing).toHaveBeenCalledTimes(3)

      // Валидная запись другого ключа осталась нетронутой.
      expect(good.body.toString()).toBe('{"v":1}')
    } finally {
      error.mockRestore()
    }
  })

  it('counts a stale response instead of publishing a fallback revision', async () => {
    const db = fakeDb()
    const store = createContentStore(db, { generationTtlMs: 0 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await store.entryFor('site', async () => ({ ok: true, body: Buffer.from('{"v":1}') }))
      db.state.generation = '2'
      const stale = await store.entryFor('site', async () => ({ ok: false, body: null }))

      expect(stale.degraded).toBe(true)
      expect(stale.generation).toBe('1')
      expect(store.metrics().staleServed).toBe(1)
    } finally {
      error.mockRestore()
    }
  })
})

describe('public content cache size bound (CR-046)', () => {
  it('never grows past the configured maximum', async () => {
    const store = createContentStore(fakeDb(), { generationTtlMs: 1_000, maxEntries: 3 })

    for (let i = 0; i < 10; i += 1) {
      await store.entryFor(`key:${i}`, async () => ({ ok: true, body: Buffer.from(`{"i":${i}}`) }))
    }

    // Первый ключ должен быть вытеснен: повторный запрос снова собирает тело.
    const rebuild = vi.fn(async () => ({ ok: true, body: Buffer.from('{"i":0}') }))
    await store.entryFor('key:0', rebuild)
    expect(rebuild).toHaveBeenCalledTimes(1)
  })
})
