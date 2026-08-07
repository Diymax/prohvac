// Ownership of translation work: the queue lease and per-job claims (CR-039).
//
// WHY A TOKEN AND NOT JUST AN OWNER. The lease used to be `{owner, until}`
// taken once per tick with a fixed TTL and never renewed. A tick longer than
// the TTL — one slow provider, one large batch — expired the lease while the
// first worker was still inside `await`, a second worker took it, claimed the
// same rows and sent them again. Both then wrote results. A random token per
// acquisition turns renewal and release into conditional writes: only the
// holder of the current token can extend or clear the record, so a superseded
// worker fails loudly instead of silently reviving a lease it no longer owns.
//
// WHY PER-JOB CLAIMS. `status = 'running'` cannot answer "is this row mine and
// is its owner still alive". The claim carries the owner, its own random token
// and a deadline, so completion is conditional on the token (a taken-over row
// rejects the late write) and recovery is conditional on the deadline (a row is
// requeued because its owner stopped renewing, not because `updated_at` looks
// old — that column is bumped by unrelated writes and is not a liveness
// signal).

import { randomBytes } from 'node:crypto'

export const LEASE_KEY = 'translate.lease'

/** Random identifier for a lease acquisition or a job claim. */
export const newToken = (bytes = 16) => randomBytes(bytes).toString('hex')

const SQL_READ = 'SELECT value FROM app_state WHERE key = ?'

const SQL_WRITE = `
  INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`

// Renewal is a single conditional statement rather than read-decide-write:
// the condition and the write cannot be separated by another process, and a
// zero-row result is exactly the "someone else owns it now" signal. json_valid
// guards a record left by an older build (or a corrupted one) — json_set on a
// non-JSON value raises and would look like a database failure.
const SQL_RENEW = `
  UPDATE app_state
     SET value = json_set(value, '$.until', ?), updated_at = ?
   WHERE key = ?
     AND json_valid(value)
     AND json_extract(value, '$.token') = ?
`

const SQL_RELEASE = `
  UPDATE app_state
     SET value = ?, updated_at = ?
   WHERE key = ?
     AND json_valid(value)
     AND json_extract(value, '$.token') = ?
`

const FREE = JSON.stringify({ owner: null, token: null, until: 0 })

/**
 * Queue lease stored in `app_state`.
 *
 * @param {object} db driver from server/db/index.js
 * @param {{key?: string, ttlMs: number}} options
 */
export const createLease = (db, options = {}) => {
  const key = options.key ?? LEASE_KEY
  const ttlMs = Math.max(1, options.ttlMs ?? 120_000)

  const read = () => {
    const row = db.get(SQL_READ, [key])
    if (!row?.value) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return null
    }
  }

  /**
   * Takes the lease unless a live one is held by somebody else.
   *
   * The transaction is mandatory: read-decide-write without it lets two
   * processes both conclude the lease is free. A record written by an older
   * build has no token — it is honoured until it expires, otherwise a deploy
   * would let two workers run side by side for one TTL.
   *
   * @returns {string|null} the token on success, null when busy
   */
  const acquire = (owner, at = Date.now()) =>
    db.transaction(() => {
      const current = read()
      const live = current && Number(current.until) > at
      if (live) return null

      const token = newToken()
      db.run(SQL_WRITE, [key, JSON.stringify({ owner, token, until: at + ttlMs }), at])
      return token
    })

  /**
   * Extends the lease if — and only if — the token still matches.
   *
   * @returns {boolean} false means the lease was taken over or cleared
   */
  const renew = (token, at = Date.now()) => {
    const info = db.run(SQL_RENEW, [at + ttlMs, at, key, String(token)])
    return (info.changes ?? 0) > 0
  }

  /** Clears the lease, again only for its current holder. */
  const release = (token, at = Date.now()) => {
    const info = db.run(SQL_RELEASE, [FREE, at, key, String(token)])
    return (info.changes ?? 0) > 0
  }

  return { key, ttlMs, read, acquire, renew, release }
}

// ---------------------------------------------------------------------------
// Job claims
// ---------------------------------------------------------------------------

const SQL_CANDIDATES = `
  SELECT id, key, lang, source_text, source_hash, attempts
    FROM translation_jobs
   WHERE status IN ('queued', 'deferred') AND run_after <= ?
   ORDER BY run_after, id
   LIMIT ?
`

const SQL_CLAIM = `
  UPDATE translation_jobs
     SET status = 'running', claim_owner = ?, claim_token = ?, claim_until = ?, updated_at = ?
   WHERE id = ? AND status IN ('queued', 'deferred')
`

const SQL_EXTEND = `
  UPDATE translation_jobs
     SET claim_until = ?
   WHERE status = 'running' AND claim_owner = ? AND claim_until > ?
`

// An expired claim is a dead owner. The second branch is the pre-migration
// shape: rows claimed before claim_until existed carry 0 and can only be judged
// by updated_at, which is why the old heuristic stays as a fallback and not as
// the rule.
const SQL_RECOVER = `
  UPDATE translation_jobs
     SET status = 'queued', claim_owner = NULL, claim_token = NULL, claim_until = 0,
         updated_at = ?
   WHERE status = 'running'
     AND ((claim_until > 0 AND claim_until <= ?) OR (claim_until = 0 AND updated_at < ?))
`

/**
 * Moves due jobs to `running` under this worker's ownership.
 *
 * Each row gets its own token so that completion can be conditional per job:
 * a shared token would let a worker that lost one row to a takeover still write
 * the results of the others in the same batch.
 *
 * @returns {object[]} claimed rows, each with `claim_token`
 */
export const claimJobs = (db, options = {}) => {
  const { limit = 200, owner, claimMs = 120_000, at = Date.now() } = options

  return db.transaction(() => {
    const rows = db.all(SQL_CANDIDATES, [at, limit])
    const claimed = []

    for (const row of rows) {
      const token = newToken(12)
      const info = db.run(SQL_CLAIM, [owner, token, at + claimMs, at, row.id])
      // Zero rows means another worker claimed it between the SELECT and the
      // UPDATE. Skipping is the whole point: the row is not ours.
      if (info.changes) claimed.push({ ...row, claim_token: token })
    }

    return claimed
  })
}

/** Pushes the deadline of every live claim of this owner. */
export const extendClaims = (db, options = {}) => {
  const { owner, until, at = Date.now() } = options
  const info = db.run(SQL_EXTEND, [until, owner, at])
  return info.changes ?? 0
}

/**
 * Requeues jobs whose claim expired.
 *
 * @returns {number} how many rows went back to the queue
 */
export const recoverExpiredClaims = (db, options = {}) => {
  const { at = Date.now(), staleMs = 240_000 } = options
  const info = db.run(SQL_RECOVER, [at, at, at - staleMs])
  return info.changes ?? 0
}
