import { describe, expect, it } from 'vitest'

import { PROGRESSIVE_MAX_MS, createRateLimiter, progressiveDelayMs } from './ratelimit.js'

// node:sqlite появился в Node 22.5 и до сих пор помечен как experimental.
// Если модуля нет — тесты лимитера пропускаем с внятной причиной в названии,
// а не роняем весь прогон: чистая функция progressiveDelayMs от БД не зависит
// и проверяется в любом случае.
let DatabaseSync = null
let unavailable = ''
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch (error) {
  unavailable = error.message
}

const describeDb = DatabaseSync
  ? describe
  : describe.skip

const suiteName = DatabaseSync
  ? 'createRateLimiter'
  : `createRateLimiter — пропущено: node:sqlite недоступен в Node ${process.version} (${unavailable})`

const WINDOW = 60_000

const makeLimiter = () => createRateLimiter(new DatabaseSync(':memory:'))

describeDb(suiteName, () => {
  it('пропускает запросы до лимита и режет после', () => {
    const rl = makeLimiter()
    const opts = { windowMs: WINDOW, max: 3, now: 1_000 }

    expect(rl.hit('ip:1', opts)).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: WINDOW,
      count: 1,
    })
    expect(rl.hit('ip:1', opts).remaining).toBe(1)
    expect(rl.hit('ip:1', opts)).toMatchObject({ allowed: true, remaining: 0, count: 3 })

    const blocked = rl.hit('ip:1', opts)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.count).toBe(4)
  })

  it('считает вёдра независимо', () => {
    const rl = makeLimiter()
    const opts = { windowMs: WINDOW, max: 1, now: 0 }

    expect(rl.hit('ip:1', opts).allowed).toBe(true)
    expect(rl.hit('ip:2', opts).allowed).toBe(true)
    expect(rl.hit('ip:1', opts).allowed).toBe(false)
  })

  it('обнуляет счётчик в новом окне', () => {
    const rl = makeLimiter()
    const opts = { windowMs: WINDOW, max: 2 }

    rl.hit('ip:1', { ...opts, now: 59_999 })
    const last = rl.hit('ip:1', { ...opts, now: 59_999 })
    expect(last.allowed).toBe(true)
    expect(rl.hit('ip:1', { ...opts, now: 59_999 }).allowed).toBe(false)

    // Ровно на границе слота начинается следующее окно.
    const fresh = rl.hit('ip:1', { ...opts, now: 60_000 })
    expect(fresh).toMatchObject({ allowed: true, count: 1, resetAt: 120_000 })
  })

  it('привязывает окно к сетке времени, а не к первому запросу', () => {
    const rl = makeLimiter()
    // 90_000 попадает во второй слот [60_000, 120_000).
    const hit = rl.hit('ip:1', { windowMs: WINDOW, max: 5, now: 90_000 })
    expect(hit.resetAt).toBe(120_000)
  })

  it('peek не увеличивает счётчик', () => {
    const rl = makeLimiter()
    const opts = { windowMs: WINDOW, max: 2, now: 0 }

    expect(rl.peek('ip:1', opts)).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: WINDOW,
      count: 0,
    })

    rl.hit('ip:1', opts)
    expect(rl.peek('ip:1', opts)).toMatchObject({ count: 1, remaining: 1 })
    expect(rl.peek('ip:1', opts)).toMatchObject({ count: 1, remaining: 1 })
  })

  it('peek без max считает лимит бесконечным', () => {
    const rl = makeLimiter()
    rl.hit('ip:1', { windowMs: WINDOW, max: 1, now: 0 })

    const seen = rl.peek('ip:1', { windowMs: WINDOW, now: 0 })
    expect(seen.count).toBe(1)
    expect(seen.allowed).toBe(true)
    expect(seen.remaining).toBe(Infinity)
  })

  it('reset очищает ведро целиком', () => {
    const rl = makeLimiter()
    const opts = { windowMs: WINDOW, max: 1, now: 0 }

    rl.hit('ip:1', opts)
    rl.hit('ip:1', { ...opts, now: WINDOW })
    rl.hit('ip:2', opts)

    expect(rl.reset('ip:1')).toBe(2)
    expect(rl.peek('ip:1', opts).count).toBe(0)
    // Соседнее ведро не задето.
    expect(rl.peek('ip:2', opts).count).toBe(1)
    expect(rl.reset('ip:1')).toBe(0)
  })

  it('gc удаляет слоты старше двух окон и не трогает свежие', () => {
    const rl = makeLimiter()
    const opts = { windowMs: WINDOW, max: 10 }

    rl.hit('ip:1', { ...opts, now: 0 })        // слот [0, 60_000)
    rl.hit('ip:1', { ...opts, now: 60_000 })   // слот [60_000, 120_000)
    rl.hit('ip:1', { ...opts, now: 120_000 })  // слот [120_000, 180_000)

    // Первый слот истёк ровно два окна назад — он под нож, остальные живы.
    expect(rl.gc(120_000)).toBe(1)
    expect(rl.peek('ip:1', { ...opts, now: 0 }).count).toBe(0)
    expect(rl.peek('ip:1', { ...opts, now: 60_000 }).count).toBe(1)
    expect(rl.peek('ip:1', { ...opts, now: 120_000 }).count).toBe(1)

    expect(rl.gc(119_999)).toBe(0)
    expect(rl.gc(10_000_000)).toBe(2)
  })

  it('gc уважает собственное окно каждого ведра', () => {
    const rl = makeLimiter()
    rl.hit('короткое', { windowMs: 1_000, max: 5, now: 0 })
    rl.hit('длинное', { windowMs: 3_600_000, max: 5, now: 0 })

    // Для окна в секунду два окна прошли, для часового — нет.
    expect(rl.gc(10_000)).toBe(1)
    expect(rl.peek('длинное', { windowMs: 3_600_000, now: 0 }).count).toBe(1)
  })

  it('отвергает бессмысленное окно вместо тихой порчи ключа', () => {
    const rl = makeLimiter()
    expect(() => rl.hit('ip:1', { windowMs: 0, max: 1 })).toThrow(TypeError)
    expect(() => rl.hit('ip:1', { windowMs: 1.5, max: 1 })).toThrow(TypeError)
    expect(() => rl.hit('ip:1', { windowMs: WINDOW, max: 0 })).toThrow(TypeError)
  })
})

describe('progressiveDelayMs', () => {
  it('не тормозит первые две неудачи', () => {
    expect(progressiveDelayMs(0)).toBe(0)
    expect(progressiveDelayMs(1)).toBe(0)
    expect(progressiveDelayMs(2)).toBe(0)
  })

  it('удваивает задержку начиная с третьей', () => {
    expect(progressiveDelayMs(3)).toBe(250)
    expect(progressiveDelayMs(4)).toBe(500)
    expect(progressiveDelayMs(5)).toBe(1_000)
    expect(progressiveDelayMs(6)).toBe(2_000)
    expect(progressiveDelayMs(7)).toBe(4_000)
  })

  it('упирается в потолок и не растёт дальше', () => {
    expect(progressiveDelayMs(8)).toBe(PROGRESSIVE_MAX_MS)
    expect(progressiveDelayMs(50)).toBe(PROGRESSIVE_MAX_MS)
    expect(progressiveDelayMs(1e9)).toBe(PROGRESSIVE_MAX_MS)
    // Fail-closed: сломанный счётчик тормозит по максимуму, а не пропускает.
    expect(progressiveDelayMs(Infinity)).toBe(PROGRESSIVE_MAX_MS)
  })

  it('не падает на мусорном вводе', () => {
    expect(progressiveDelayMs(-5)).toBe(0)
    expect(progressiveDelayMs(NaN)).toBe(0)
    expect(progressiveDelayMs(undefined)).toBe(0)
    expect(progressiveDelayMs('4')).toBe(500)
  })
})
