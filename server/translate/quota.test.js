// CR-040. The hard monthly quota under concurrent workers.
//
// `preflight -> provider call -> usage.add` has two await points inside it, so
// two workers could pass the same check against the same remaining quota and
// both send. The reservation moves the decision and the accounting into one
// transaction; these tests pin the boundary behaviour of that transaction.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SETTING_KEYS } from '../../shared/settings.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createUsage, SAFETY_RATIO } from './usage.js'
import { createTranslateWorker, enqueueForKey, sourceHash } from './worker.js'

const PROVIDER = 'fake'

const createTestDb = () => {
  const db = createSqliteDriver(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

/** Monthly limit for the stub provider; DEFAULT_LIMITS knows nothing about it. */
const setLimit = (db, chars) =>
  db.run(
    `INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SETTING_KEYS.TRANSLATION_LIMITS, JSON.stringify({ [PROVIDER]: chars }), Date.now()]
  )

const held = (db) =>
  db.get(
    "SELECT COALESCE(SUM(chars), 0) AS chars FROM translation_quota_reservations WHERE state = 'held'"
  ).chars

const spent = (db, usage) => usage.readLocal(PROVIDER).chars

const deferred = () => {
  let resolve = null
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: условие не наступило')
    await sleep(5)
  }
}

/** Provider stub: no network, optional hold before answering. */
const stubProvider = (onCall = null) => {
  const calls = []
  return {
    calls,
    provider: {
      code: PROVIDER,
      title: 'Fake',
      maxBatchTexts: 50,
      maxBatchChars: 25_000,
      configFields: [],
      isConfigured: () => true,
      supports: () => true,
      toProviderLang: (lang) => lang,
      usage: async () => null,
      translate: async (texts, lang) => {
        calls.push({ texts: [...texts], lang })
        if (onCall) await onCall()
        return { texts: texts.map((text) => `[${lang}] ${text}`), billedChars: texts.join('').length }
      },
    },
  }
}

const makeQuotaWorker = (db, usage, provider, options = {}) =>
  createTranslateWorker(db, {
    usage,
    leaseMs: 5_000,
    warn: () => {},
    registry: {
      pick: async () => ({ provider, reason: null }),
      noteSuccess: () => {},
      noteFailure: () => {},
      usage: null,
    },
    ...options,
  })

describe('quota reservations (CR-040)', () => {
  let db

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => db.close())

  it('holds characters before the request and converts them to real usage', async () => {
    setLimit(db, 1_000)
    const usage = createUsage(db)

    const reservation = await usage.reserve(PROVIDER, null, { chars: 100, owner: 'w1' })
    expect(reservation.ok).toBe(true)
    expect(held(db)).toBe(100)
    expect(spent(db, usage)).toBe(0)

    // Провайдер посчитал больше заявленного — расход корректируется по факту.
    expect(usage.commit(reservation.token, 140)).toBe(true)
    expect(held(db)).toBe(0)
    expect(spent(db, usage)).toBe(140)
  })

  it('refuses quota that another worker has already promised but not yet spent', async () => {
    setLimit(db, 1_000)
    const first = createUsage(db)
    const second = createUsage(db)

    // Первый воркер отправил пачку и ждёт ответа: символы обещаны, но ещё
    // не списаны. Ровно в этой точке старая схема показывала нулевой расход.
    const promised = await first.reserve(PROVIDER, null, { chars: 600, owner: 'w1' })
    expect(promised.ok).toBe(true)
    expect(spent(db, second)).toBe(0)

    const late = await second.reserve(PROVIDER, null, { chars: 600, owner: 'w2' })
    expect(late).toMatchObject({ ok: false, reason: 'quota_exhausted' })
    await expect(second.preflight(PROVIDER, null, { chars: 600 })).resolves.toMatchObject({
      ok: false,
    })
  })

  it('never lets two simultaneous reservations cross the hard limit', async () => {
    // Потолок = 1000 * 0.95 = 950, то есть влезает ровно одна пачка на 600.
    setLimit(db, 1_000)
    const first = createUsage(db)
    const second = createUsage(db)

    const [a, b] = await Promise.all([
      first.reserve(PROVIDER, null, { chars: 600, owner: 'w1' }),
      second.reserve(PROVIDER, null, { chars: 600, owner: 'w2' }),
    ])

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const winner = a.ok ? a : b
    const loser = a.ok ? b : a
    expect(loser.reason).toBe('quota_exhausted')
    expect(held(db)).toBe(600)

    first.commit(winner.token, 600)
    expect(spent(db, first)).toBe(600)
    expect(600).toBeLessThanOrEqual(1_000 * SAFETY_RATIO)
  })

  it('releases the hold when the send is abandoned before it happens', async () => {
    setLimit(db, 1_000)
    const usage = createUsage(db)

    const reservation = await usage.reserve(PROVIDER, null, { chars: 900, owner: 'w1' })
    expect(reservation.ok).toBe(true)
    expect(usage.release(reservation.token, 'pre_send_failure')).toBe(true)

    expect(held(db)).toBe(0)
    expect(spent(db, usage)).toBe(0)
    // Освобождённое удержание не подтверждается задним числом.
    expect(usage.commit(reservation.token, 900)).toBe(false)

    const next = await usage.reserve(PROVIDER, null, { chars: 900, owner: 'w2' })
    expect(next.ok).toBe(true)
  })

  it('reclaims an expired hold instead of losing the quota until next month', async () => {
    setLimit(db, 1_000)
    const usage = createUsage(db)
    const at = Date.now()

    const dead = await usage.reserve(PROVIDER, null, { chars: 900, owner: 'dead', ttlMs: 1, now: at })
    expect(dead.ok).toBe(true)

    // Пока удержание живо, следующая пачка не проходит.
    const blocked = await usage.reserve(PROVIDER, null, { chars: 900, owner: 'w2', now: at })
    expect(blocked).toMatchObject({ ok: false, reason: 'quota_exhausted' })

    const later = at + 60_000
    const revived = await usage.reserve(PROVIDER, null, { chars: 900, owner: 'w2', now: later })
    expect(revived.ok).toBe(true)
    expect(
      db.get("SELECT state, reason FROM translation_quota_reservations WHERE token = ?", [dead.token])
    ).toMatchObject({ state: 'released', reason: 'expired' })

    // Символы протухшего удержания всё же были потрачены — счёт признаётся.
    expect(usage.commit(dead.token, 900, later)).toBe(true)
    expect(spent(db, usage)).toBe(900)
  })

  it('blocks a worker whose batch does not fit the remaining quota', async () => {
    setLimit(db, 200)
    const source = 'Очень длинный русский текст, который не помещается в остаток квоты'
    const at = Date.now()
    db.run(
      `INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash,
                                    provider, translated_at, updated_at)
       VALUES ('ru', 'q1', ?, 'manual', 0, ?, NULL, NULL, ?)`,
      [source, sourceHash(source), at]
    )
    enqueueForKey(db, 'q1', source, { langs: ['en'] })

    const usage = createUsage(db)
    usage.add(PROVIDER, 180)

    const { calls, provider } = stubProvider()
    const summary = await makeQuotaWorker(db, usage, provider).tick()

    expect(calls).toHaveLength(0)
    expect(summary).toMatchObject({ claimed: 1, applied: 0, deferred: 1 })
    expect(db.get('SELECT last_error FROM translation_jobs').last_error).toContain('quota')
    // Ни одного повисшего удержания после отказа.
    expect(held(db)).toBe(0)
    expect(spent(db, usage)).toBe(180)
  })

  it('stops the second worker at the quota boundary while the first is in flight', async () => {
    // Потолок 950 символов: две пачки по ~600 в него не помещаются.
    setLimit(db, 1_000)
    const long = 'а'.repeat(600)
    for (const key of ['q1', 'q2']) {
      db.run(
        `INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash,
                                      provider, translated_at, updated_at)
         VALUES ('ru', ?, ?, 'manual', 0, ?, NULL, NULL, ?)`,
        [key, long, sourceHash(long), Date.now()]
      )
    }
    enqueueForKey(db, 'q1', long, { langs: ['en'] })
    enqueueForKey(db, 'q2', long, { langs: ['en'] })

    const usage = createUsage(db)
    const gate = deferred()
    const slow = stubProvider(() => gate.promise)
    const fast = stubProvider()

    // Первый воркер берёт одну задачу и застревает в запросе к провайдеру:
    // удержание уже стоит, расход ещё не списан.
    const first = makeQuotaWorker(db, usage, slow.provider, { batchLimit: 1, heartbeatMs: 0 })
    const running = first.tick()
    await waitUntil(() => slow.calls.length === 1)
    expect(held(db)).toBeGreaterThan(0)

    // Аренда протухла — за вторую задачу берётся другой процесс пула.
    db.run("UPDATE app_state SET value = json_set(value, '$.until', 0) WHERE key = 'translate.lease'")
    const second = await makeQuotaWorker(db, usage, fast.provider).tick()

    expect(fast.calls).toHaveLength(0)
    expect(second).toMatchObject({ claimed: 1, applied: 0, deferred: 1 })
    expect(db.get("SELECT last_error FROM translation_jobs WHERE key = 'q2'").last_error).toContain(
      'quota'
    )

    gate.resolve()
    await running

    expect(spent(db, usage)).toBeLessThanOrEqual(1_000 * SAFETY_RATIO)
    expect(held(db)).toBe(0)
  })

  it('releases holds owned by a worker that is shutting down', async () => {
    setLimit(db, 10_000)
    const usage = createUsage(db)

    const mine = await usage.reserve(PROVIDER, null, { chars: 300, owner: 'w1' })
    const other = await usage.reserve(PROVIDER, null, { chars: 300, owner: 'w2' })
    expect(mine.ok && other.ok).toBe(true)

    expect(usage.releaseOwned('w1', 'shutdown')).toBe(1)
    expect(held(db)).toBe(300)
  })
})
