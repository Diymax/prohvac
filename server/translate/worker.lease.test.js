// CR-039. Ownership of translation work under concurrency.
//
// Every case here used to be a double send: the lease was taken once with a
// fixed TTL, so a tick longer than that TTL let a second worker claim the same
// rows while the first was still waiting on the provider.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { LEASE_KEY } from './lease.js'
import { ProviderError } from './provider.js'
import { createTranslateWorker, enqueueForKey, sourceHash } from './worker.js'

const createTestDb = () => {
  const db = createSqliteDriver(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

const putRussian = (db, key, value) => {
  const at = Date.now()
  db.run(
    `INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash,
                                  provider, translated_at, updated_at)
     VALUES ('ru', ?, ?, 'manual', 0, ?, NULL, NULL, ?)
     ON CONFLICT(locale, key) DO UPDATE SET value = excluded.value,
                                            source_hash = excluded.source_hash`,
    [key, value, sourceHash(value), at]
  )
}

/** Puts one job per language and returns the source text. */
const seed = (db, key, lang, text = `Текст ${key}`) => {
  putRussian(db, key, text)
  enqueueForKey(db, key, text, { langs: [lang] })
  return text
}

const deferred = () => {
  let resolve = null
  let reject = null
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: условие не наступило')
    await sleep(5)
  }
}

/**
 * Provider stub. Never touches the network; `onCall` lets a test hold the
 * request open for as long as the scenario needs.
 */
const gatedProvider = (code = 'fake') => {
  const state = { calls: [], signals: [], onCall: null }
  const provider = {
    code,
    title: code,
    maxBatchTexts: 50,
    maxBatchChars: 25_000,
    configFields: [],
    isConfigured: () => true,
    supports: () => true,
    toProviderLang: (lang) => lang,
    usage: async () => null,
    translate: async (texts, lang, options = {}) => {
      state.calls.push({ texts: [...texts], lang })
      state.signals.push(options.signal ?? null)
      if (state.onCall) await state.onCall(state.calls.length)
      return {
        texts: texts.map((text) => `[${code}] ${text}`),
        billedChars: texts.join('').length,
      }
    },
  }
  return { state, provider }
}

const openUsage = () => ({
  preflight: async () => ({ ok: true, used: 0, limit: null }),
  reserve: async () => ({ ok: true, token: `t${Math.random()}`, chars: 0 }),
  commit: () => true,
  release: () => true,
  releaseOwned: () => 0,
  add: () => {},
})

const makeWorker = (db, provider, options = {}) =>
  createTranslateWorker(db, {
    registry: {
      pick: async () => ({ provider, reason: null }),
      noteSuccess: () => {},
      noteFailure: () => {},
      usage: null,
    },
    usage: openUsage(),
    warn: () => {},
    ...options,
  })

const readLease = (db) => JSON.parse(db.get('SELECT value FROM app_state WHERE key = ?', [LEASE_KEY]).value)

const overwriteLease = (db, record) =>
  db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [LEASE_KEY, JSON.stringify(record), Date.now()]
  )

describe('translation lease (CR-039)', () => {
  let db

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => db.close())

  it('keeps the lease across a tick longer than its initial TTL', async () => {
    seed(db, 'k1', 'en')
    const gate = deferred()
    const { state, provider } = gatedProvider()
    state.onCall = () => gate.promise

    const first = makeWorker(db, provider, { leaseMs: 300, heartbeatMs: 40 })
    const running = first.tick()
    await waitUntil(() => state.calls.length === 1)

    const takenAt = readLease(db).until
    // Дольше исходного TTL: без продления аренда к этому моменту протухла бы.
    await sleep(700)
    expect(readLease(db).until).toBeGreaterThan(takenAt)

    gate.resolve()
    const summary = await running
    expect(summary.applied).toBe(1)
    expect(summary.lease).toBeUndefined()
  })

  it('refuses a second worker while the first still holds a renewed lease', async () => {
    seed(db, 'k1', 'en')
    const gate = deferred()
    const { state, provider } = gatedProvider()
    state.onCall = () => gate.promise

    const first = makeWorker(db, provider, { leaseMs: 300, heartbeatMs: 40 })
    const running = first.tick()
    await waitUntil(() => state.calls.length === 1)
    await sleep(500)

    const { state: other, provider: otherProvider } = gatedProvider('other')
    const second = await makeWorker(db, otherProvider, { leaseMs: 300 }).tick()

    expect(second).toMatchObject({ lease: 'busy', claimed: 0 })
    expect(other.calls).toHaveLength(0)
    expect(db.get('SELECT claim_owner FROM translation_jobs').claim_owner).toBe(first.owner)

    gate.resolve()
    await running
  })

  it('stops processing when the lease is taken over mid-request', async () => {
    seed(db, 'k1', 'en')
    seed(db, 'k2', 'tr')
    const gate = deferred()
    const { state, provider } = gatedProvider()
    state.onCall = (call) => (call === 1 ? gate.promise : Promise.resolve())

    const worker = makeWorker(db, provider, { leaseMs: 5_000, heartbeatMs: 0 })
    const running = worker.tick()
    await waitUntil(() => state.calls.length === 1)

    // Перехват: запись аренды принадлежит другому токену.
    overwriteLease(db, { owner: 'ghost', token: 'ghost-token', until: Date.now() + 60_000 })
    gate.resolve()

    const summary = await running
    expect(summary.lease).toBe('lost')
    // Вторая группа языков не отправлялась вовсе.
    expect(state.calls).toHaveLength(1)
    expect(db.get("SELECT status FROM translation_jobs WHERE lang = 'tr'").status).toBe('running')
    // Аренда перехватчика не тронута.
    expect(readLease(db).token).toBe('ghost-token')
  })

  it('treats a failing heartbeat as a lost lease', async () => {
    seed(db, 'k1', 'en')
    seed(db, 'k2', 'tr')
    const { state, provider } = gatedProvider()

    const broken = {
      ...db,
      run: (sql, params) => {
        if (sql.includes('json_set')) throw new Error('database is locked')
        return db.run(sql, params)
      },
    }

    const worker = makeWorker(broken, provider, { leaseMs: 5_000, heartbeatMs: 0 })
    const summary = await worker.tick()

    expect(summary.lease).toBe('lost')
    expect(state.calls.length).toBeLessThan(2)
  })

  it('aborts the provider request and releases the lease on stop()', async () => {
    seed(db, 'k1', 'en')
    const gate = deferred()
    const { state, provider } = gatedProvider()
    state.onCall = () => gate.promise

    const worker = makeWorker(db, provider, { leaseMs: 5_000, heartbeatMs: 0 })
    const running = worker.tick()
    await waitUntil(() => state.calls.length === 1)

    const released = await worker.stop({ timeoutMs: 50 })

    expect(state.signals[0].aborted).toBe(true)
    expect(released.lease).toBe(true)
    expect(readLease(db)).toMatchObject({ token: null, until: 0 })

    gate.resolve()
    await running
  })

  it('recovers only genuinely expired claims', () => {
    seed(db, 'k1', 'en')
    seed(db, 'k2', 'tr')
    seed(db, 'k3', 'ar')
    const at = Date.now()

    db.run(
      "UPDATE translation_jobs SET status='running', claim_owner='dead', claim_token='a', claim_until=? WHERE lang='en'",
      [at - 1]
    )
    db.run(
      "UPDATE translation_jobs SET status='running', claim_owner='alive', claim_token='b', claim_until=? WHERE lang='tr'",
      [at + 60_000]
    )
    // Строка, заклиненная до миграции: claim_until нет, судить можно только
    // по updated_at.
    db.run(
      "UPDATE translation_jobs SET status='running', claim_until=0, updated_at=? WHERE lang='ar'",
      [at - 10 * 60_000]
    )

    const worker = makeWorker(db, gatedProvider().provider, { leaseMs: 60_000 })
    expect(worker.recover()).toBe(2)

    const byLang = Object.fromEntries(
      db.all('SELECT lang, status FROM translation_jobs').map((row) => [row.lang, row.status])
    )
    expect(byLang).toMatchObject({ en: 'queued', tr: 'running', ar: 'queued' })
  })

  it('picks up work left behind by a crashed worker on the next start', async () => {
    seed(db, 'k1', 'en')
    const at = Date.now()
    db.run(
      "UPDATE translation_jobs SET status='running', claim_owner='crashed', claim_token='gone', claim_until=?",
      [at - 1]
    )
    overwriteLease(db, { owner: 'crashed', token: 'gone', until: at - 1 })

    const { state, provider } = gatedProvider()
    const summary = await makeWorker(db, provider, { leaseMs: 5_000 }).tick()

    expect(summary).toMatchObject({ recovered: 1, claimed: 1, applied: 1, translated: 1 })
    expect(state.calls).toHaveLength(1)
  })

  it('refuses a late write from a superseded worker and keeps one terminal result', async () => {
    seed(db, 'k1', 'en')
    const gate = deferred()
    const slow = gatedProvider('slow')
    slow.state.onCall = () => gate.promise

    const stale = makeWorker(db, slow.provider, { leaseMs: 5_000, heartbeatMs: 0 })
    const running = stale.tick()
    await waitUntil(() => slow.state.calls.length === 1)

    // Такт перехвата: аренда старого воркера истекла, его claim тоже.
    overwriteLease(db, { owner: 'next', token: 'next-token', until: Date.now() - 1 })
    db.run('UPDATE translation_jobs SET claim_until = 1')

    const fresh = gatedProvider('fresh')
    const takeover = await makeWorker(db, fresh.provider, { leaseMs: 5_000 }).tick()
    expect(takeover).toMatchObject({ recovered: 1, applied: 1 })

    gate.resolve()
    const late = await running

    expect(late.applied).toBe(0)
    expect(late.lost).toBe(1)

    const value = db.get("SELECT value FROM content_entries WHERE locale='en' AND key='k1'").value
    expect(value).toBe('[fresh] Текст k1')

    const jobs = db.all("SELECT status, provider FROM translation_jobs WHERE key='k1'")
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ status: 'done', provider: 'fresh' })
    expect(db.get("SELECT value FROM app_state WHERE key='content_generation'").value).toBe('1')
  })

  it('counts a failure only for the rows it still owns', async () => {
    seed(db, 'k1', 'en')
    seed(db, 'k2', 'en')
    const gate = deferred()
    const { state, provider } = gatedProvider()
    state.onCall = () => gate.promise

    const worker = makeWorker(db, provider, { leaseMs: 5_000, heartbeatMs: 0 })
    const running = worker.tick()
    await waitUntil(() => state.calls.length === 1)

    // Одну строку успел перехватить другой процесс.
    db.run("UPDATE translation_jobs SET claim_token = 'stolen' WHERE key = 'k2'")
    gate.reject(new ProviderError('auth', 'ключ отозван'))

    const summary = await running
    expect(summary).toMatchObject({ failed: 1, lost: 1, deferred: 0 })

    const byKey = Object.fromEntries(
      db.all('SELECT key, status FROM translation_jobs').map((row) => [row.key, row.status])
    )
    expect(byKey).toMatchObject({ k1: 'failed', k2: 'running' })
  })

  it('counts real transitions, not batch size', async () => {
    seed(db, 'k1', 'en')
    seed(db, 'k2', 'en')
    const { provider } = gatedProvider()

    const worker = makeWorker(db, provider, {
      leaseMs: 5_000,
      registry: {
        pick: async () => ({ provider: null, reason: 'not_configured' }),
        noteSuccess: () => {},
        noteFailure: () => {},
        usage: null,
      },
    })

    const summary = await worker.tick()
    expect(summary).toMatchObject({ claimed: 2, deferred: 2, applied: 0, failed: 0, lost: 0 })
    expect(db.get("SELECT COUNT(*) n FROM translation_jobs WHERE status='deferred'").n).toBe(2)
  })
})
