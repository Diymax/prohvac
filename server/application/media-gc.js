import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_FS,
  inspect,
  isActive,
  MEDIA_AVAILABILITY,
  removeIfPresent,
} from './media-internals.js'

/**
 * Garbage collection and disk/database reconciliation for media.
 *
 * The other half of the subsystem (`media-storage.js`) publishes files and
 * restores rows; this one removes what is no longer referenced and repairs the
 * state when the two sides have drifted apart. CR-059 separated them because a
 * single 583-line file was past the decomposition guideline in CLAUDE.md §1.
 */

// A unlink that failed with a retryable errno (EACCES, EPERM, EBUSY, EIO)
// is retried with exponential backoff. Without a deadline a permanently locked
// file would be retried on every pass and its warning would drown the log.
const UNLINK_RETRY_BASE_MS = 60 * 60_000
const UNLINK_RETRY_MAX_MS = 24 * 60 * 60_000
const MAX_ERROR_TEXT = 200

// Soft-deleted files stay on disk for a week so an accidental replacement can
// be rolled back and cached pages stop referencing them first.
export const GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000

const retryDelay = (attempts) =>
  Math.min(UNLINK_RETRY_MAX_MS, UNLINK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))

const errorText = (error) =>
  String(error?.code || error?.message || 'unknown').slice(0, MAX_ERROR_TEXT)

// References are re-checked with direct queries rather than a counter: a
// counter drifts on any missed code path, four subqueries cannot.
const SQL_UNREFERENCED = `
  id NOT IN (SELECT cover_media_id FROM projects WHERE cover_media_id IS NOT NULL)
  AND id NOT IN (SELECT media_id FROM project_photos)
  AND id NOT IN (SELECT media_id FROM partners WHERE media_id IS NOT NULL)
  AND id NOT IN (SELECT icon_media_id FROM advantages WHERE icon_media_id IS NOT NULL)`

/**
 * Builds the collection half of media storage over the same database and
 * directory the upload half publishes into.
 *
 * @returns {{collect: Function, purge: Function}}
 */
export const createMediaCollector = ({ db, mediaDirectory, fs = DEFAULT_FS } = {}) => {
  const byId = (id) => db.get('SELECT * FROM media WHERE id = ?', [id])

  /**
   * Removes the file of one row and then the row itself.
   *
   * CR-037: the row survives every unlink outcome except success and `ENOENT`.
   * Dropping it after an `EACCES` or `EBUSY` used to throw away the only
   * reference to a file that kept occupying the quota.
   */
  const collectOne = async (row, now) => {
    const path = join(mediaDirectory, row.filename)
    try {
      await fs.unlink(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const attempts = (Number(row.unlink_attempts) || 0) + 1
        db.run(
          `UPDATE media
              SET availability = 'pending_delete',
                  unlink_attempts = ?,
                  unlink_error = ?,
                  unlink_retry_after = ?,
                  availability_checked_at = ?
            WHERE id = ?`,
          [attempts, errorText(error), now + retryDelay(attempts), now, row.id]
        )
        return {
          kind: 'retained',
          id: row.id,
          filename: row.filename,
          code: error?.code ?? 'unknown',
          attempts,
          retryAfter: now + retryDelay(attempts),
        }
      }
    }

    // The file is gone for certain. Recording that before deleting the row
    // keeps the state truthful if the row delete itself fails: the next pass
    // sees `deleted`, hits ENOENT and finishes the job.
    db.run(
      `UPDATE media SET availability = 'deleted', unlink_error = NULL,
              unlink_retry_after = NULL, availability_checked_at = ?
        WHERE id = ?`,
      [now, row.id]
    )
    db.run('DELETE FROM media WHERE id = ?', [row.id])
    return { kind: 'removed', id: row.id, filename: row.filename }
  }

  /**
   * Physically removes what has been soft-deleted long enough and is
   * referenced by nothing.
   *
   * @returns {Promise<{removed: number, retained: Array<object>}>}
   */
  const collect = async ({ now = Date.now(), graceMs = GC_GRACE_MS } = {}) => {
    const rows = db.all(
      `SELECT id, filename, unlink_attempts FROM media
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
          AND availability <> 'missing'
          AND (unlink_retry_after IS NULL OR unlink_retry_after <= ?)
          AND ${SQL_UNREFERENCED}`,
      [now - graceMs, now]
    )

    let removed = 0
    const retained = []
    for (const row of rows) {
      try {
        const outcome = await collectOne(row, now)
        if (outcome.kind === 'removed') removed += 1
        else retained.push(outcome)
      } catch (error) {
        // One unhappy row must not abort the sweep: that is the same failure
        // mode CR-037 is about, only one level up.
        retained.push({
          kind: 'retained',
          id: row.id,
          filename: row.filename,
          code: errorText(error),
          attempts: Number(row.unlink_attempts) || 0,
          retryAfter: now + retryDelay(1),
        })
      }
    }
    return { removed, retained }
  }

  /**
   * Final, operator-driven removal of a row that cannot be repaired.
   *
   * @returns {Promise<{kind: 'purged'|'not_found'|'active'|'in_use'|'unlink_failed', code?: string}>}
   */
  const purge = async ({ id, now = Date.now() }) => {
    const row = byId(id)
    if (!row) return { kind: 'not_found' }
    if (isActive(row)) return { kind: 'active' }
    if (!db.get(`SELECT 1 AS ok FROM media WHERE id = ? AND ${SQL_UNREFERENCED}`, [id])) {
      return { kind: 'in_use' }
    }

    const outcome = await collectOne(row, now)
    return outcome.kind === 'removed'
      ? { kind: 'purged' }
      : { kind: 'unlink_failed', code: outcome.code }
  }

  return { collect, purge }
}

/**
 * Brings the database and the media directory back in sync.
 *
 * A row whose file vanished becomes `missing` and is soft-deleted at the same
 * time, because `deleted_at IS NULL` is the gate every public content query
 * uses to decide what may be published. Restoring such a row goes through
 * `restore()`, which prices it against the quota first.
 */
export const reconcileMediaStorage = async ({
  db,
  mediaDirectory,
  temporaryDirectory,
  now = Date.now(),
  orphanGraceMs = 24 * 60 * 60_000,
  tempGraceMs = 60 * 60_000,
  fs = DEFAULT_FS,
} = {}) => {
  await mkdir(mediaDirectory, { recursive: true })
  await mkdir(temporaryDirectory, { recursive: true })

  const rows = db.all('SELECT id, filename, deleted_at, availability FROM media')
  const known = new Set(rows.map((row) => row.filename))
  const missing = []
  const unreadable = []

  for (const row of rows) {
    const state = await inspect(join(mediaDirectory, row.filename), fs)
    if (state.present) continue
    if (state.reason === 'unreadable') {
      // Permission problems say nothing about existence. Flipping the row to
      // `missing` here would unpublish healthy media over a chmod accident.
      unreadable.push({ id: row.id, filename: row.filename, code: state.error?.code ?? 'unknown' })
      continue
    }
    // A soft-deleted row without a file is the expected outcome of collection.
    if (row.availability === MEDIA_AVAILABILITY.PENDING_DELETE) continue
    if (row.availability === MEDIA_AVAILABILITY.MISSING) {
      missing.push({ id: row.id, filename: row.filename })
      continue
    }
    db.run(
      `UPDATE media
          SET availability = 'missing',
              deleted_at = COALESCE(deleted_at, ?),
              availability_checked_at = ?
        WHERE id = ?`,
      [now, now, row.id]
    )
    missing.push({ id: row.id, filename: row.filename })
  }

  let removedOrphans = 0
  const orphanFailures = []
  const symlinks = []
  for (const entry of await fs.readdir(mediaDirectory, { withFileTypes: true })) {
    const path = join(mediaDirectory, entry.name)
    // Dirent types come from lstat, so a symlink never reports isFile(). It is
    // reported rather than deleted: something placed it there deliberately, and
    // an unlink here would silently undo an operator's decision.
    if (entry.isSymbolicLink?.()) {
      symlinks.push(entry.name)
      continue
    }
    if (!entry.isFile() || known.has(entry.name)) continue
    try {
      const info = await fs.stat(path)
      if (now - info.mtimeMs < orphanGraceMs) continue
      await removeIfPresent(path, fs)
      removedOrphans += 1
    } catch (error) {
      // A locked or unreadable orphan is a warning, not a reason to abandon the
      // rest of the sweep.
      orphanFailures.push({ filename: entry.name, code: error?.code ?? 'unknown' })
    }
  }

  let removedTemps = 0
  for (const entry of await fs.readdir(temporaryDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink?.()) {
      symlinks.push(entry.name)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.part')) continue
    const path = join(temporaryDirectory, entry.name)
    try {
      const info = await fs.stat(path)
      if (now - info.mtimeMs < tempGraceMs) continue
      await removeIfPresent(path, fs)
      removedTemps += 1
    } catch (error) {
      orphanFailures.push({ filename: entry.name, code: error?.code ?? 'unknown' })
    }
  }

  return { missing, unreadable, removedOrphans, removedTemps, orphanFailures, symlinks }
}
