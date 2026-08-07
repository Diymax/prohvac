// SQLite access to the `settings` table.
//
// This repository is the single owner of settings persistence. It knows the
// column layout, it runs every statement against the table, and it is the only
// module that turns stored ciphertext into plaintext: `open()` from
// crypto/secretbox.js is called here and nowhere else, together with `seal()`
// and `preview()` on the write path. Callers - the admin API, the public lead
// route, the translation providers - get either a row or an inspected secret
// record, so a change to the storage or crypto format has exactly one owner.
//
// SECRETS ARE NEVER CACHED. Neither the ciphertext nor the plaintext is kept
// between calls: every secret read hits the table again. A row edited outside
// this repository (a manual UPDATE, a corrupted BLOB) must therefore become
// visible immediately, which is what the corrupt-ciphertext behaviour relies
// on. Only plain values are cacheable, and the caller decides that using the
// revision counter exposed here.

import { SECRET_STATE, inspectSecretSetting } from '../../shared/settings.js'
import { open, preview as previewSecret, seal } from '../crypto/secretbox.js'

const COLUMNS = 'key, value, is_secret, value_ct, value_iv, value_tag, preview, updated_at'

const SQL_LIST = `SELECT ${COLUMNS} FROM settings`

const SQL_ONE = `SELECT ${COLUMNS} FROM settings WHERE key = ?`

// Row count plus the newest write timestamp. Both are needed: an update keeps
// the count and moves the timestamp, a delete does the opposite.
const SQL_REVISION = 'SELECT COUNT(*) AS row_count, MAX(updated_at) AS updated_at FROM settings'

const SQL_UPSERT = `
  INSERT INTO settings (key, value, is_secret, value_ct, value_iv, value_tag,
                        preview, updated_at, updated_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value      = excluded.value,
    is_secret  = excluded.is_secret,
    value_ct   = excluded.value_ct,
    value_iv   = excluded.value_iv,
    value_tag  = excluded.value_tag,
    preview    = excluded.preview,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`

const SQL_DELETE = 'DELETE FROM settings WHERE key = ?'

// Public content responses are cached per generation (see routes/public.content.js),
// so a setting that shows up on the landing page has to advance that counter.
const SQL_BUMP_CONTENT_GENERATION = `
  INSERT INTO app_state (key, value, updated_at)
  VALUES ('content_generation', '1', ?)
  ON CONFLICT(key) DO UPDATE SET
    value = CAST(CAST(app_state.value AS INTEGER) + 1 AS TEXT),
    updated_at = excluded.updated_at
`

/**
 * Storage-level access to application settings.
 *
 * @param {object} db connection from server/db/index.js
 * @param {{scope?: string}} options log scope used in secret diagnostics
 */
export const createSettingsRepository = (db, { scope: defaultScope = 'settings' } = {}) => {
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('settings repository: нужно соединение из server/db/index.js')
  }

  // Every write made through this instance bumps the counter. Without it two
  // writes inside the same millisecond would share a revision and a cached
  // snapshot could keep serving the first one.
  let localEpoch = 0

  /**
   * Inspects a stored secret row and, when it authenticates, decrypts it.
   * Only the key and a closed reason code are logged: ciphertext, preview,
   * plaintext and crypto exception messages are deliberately excluded.
   */
  const inspect = (key, purpose, row, scope) =>
    inspectSecretSetting(row, {
      decrypt: (box) => open(box, purpose),
      warn: (reason) => console.warn(`[${scope}] secret record invalid: key=${key} reason=${reason}`),
    })

  return {
    /** All rows, unfiltered. Throws when the table cannot be read. */
    listRows: () => db.all(SQL_LIST),

    /** One row or undefined. Throws when the table cannot be read. */
    readRow: (key) => db.get(SQL_ONE, [key]),

    /**
     * State of a stored secret; the plaintext is present only for
     * SECRET_STATE.COMPLETE.
     *
     * Never throws: an unreadable table means the secret is unusable, and the
     * caller has to fall back rather than fail the whole request.
     */
    readSecret: (key, purpose, { scope = defaultScope } = {}) => {
      let row
      try {
        row = db.get(SQL_ONE, [key])
      } catch {
        console.warn(`[${scope}] secret record unavailable: key=${key}`)
        return { state: SECRET_STATE.CORRUPT, reason: 'read_failed', value: null }
      }
      return inspect(key, purpose, row, scope)
    },

    /** Same inspection for a row the caller already has (the admin listing). */
    inspectRow: (key, purpose, row, { scope = defaultScope } = {}) =>
      inspect(key, purpose, row, scope),

    /**
     * Revision of the whole table. Changes on any write, from this process or
     * from a neighbouring one in the Passenger pool, and is cheap enough to be
     * read on every settings access.
     */
    revision: () => {
      const row = db.get(SQL_REVISION)
      return `${row?.row_count ?? 0}:${row?.updated_at ?? 0}:${localEpoch}`
    },

    /** Writes a non-secret value already encoded as a column string. */
    writePlain: (key, value, { now = Date.now(), updatedBy = null } = {}) => {
      // The table CHECK physically forbids a secret in the plain column; the
      // explicit nulls here express the same rule before the database does.
      db.run(SQL_UPSERT, [key, value, 0, null, null, null, null, now, updatedBy])
      localEpoch += 1
    },

    /**
     * Encrypts and writes a secret. Returns the mask ('dpl_****4f2a') that is
     * the only representation allowed to leave the server.
     */
    writeSecret: (key, plaintext, purpose, { now = Date.now(), updatedBy = null } = {}) => {
      const mask = previewSecret(plaintext)
      const box = seal(plaintext, purpose)
      db.run(SQL_UPSERT, [key, null, 1, box.ct, box.iv, box.tag, mask, now, updatedBy])
      localEpoch += 1
      return mask
    },

    remove: (key) => {
      db.run(SQL_DELETE, [key])
      localEpoch += 1
    },

    bumpContentGeneration: (now = Date.now()) => {
      db.run(SQL_BUMP_CONTENT_GENERATION, [now])
    },
  }
}

// One instance per connection: the local write counter has to be shared by
// every consumer of the same database, otherwise a write made through the
// admin API would not invalidate a snapshot held by the public routes.
const repositories = new WeakMap()

/** Shared repository for a connection. */
export const getSettingsRepository = (db) => {
  let repository = repositories.get(db)
  if (!repository) {
    repository = createSettingsRepository(db)
    repositories.set(db, repository)
  }
  return repository
}

/**
 * Inspected secret record for callers that hold only a connection.
 *
 * Exists so that no module outside this file has to import the crypto
 * primitives: the translation providers read their API keys through it.
 */
export const readSecretRecord = (db, key, purpose, options) =>
  getSettingsRepository(db).readSecret(key, purpose, options)
