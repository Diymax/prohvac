import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { createMediaCollector, GC_GRACE_MS, reconcileMediaStorage } from './media-gc.js'
import {
  DEFAULT_FS,
  inspect,
  isActive,
  MEDIA_AVAILABILITY,
  removeIfPresent,
} from './media-internals.js'

/**
 * Upload and restore for media files.
 *
 * CR-059 moved collection, purging and reconciliation into `media-gc.js`; this
 * module keeps the publication side and remains the single entry point for
 * callers, so `MEDIA_AVAILABILITY`, `GC_GRACE_MS` and `reconcileMediaStorage`
 * are re-exported here unchanged.
 */
export { GC_GRACE_MS, MEDIA_AVAILABILITY, reconcileMediaStorage }

const safeRequestId = (value) =>
  String(value ?? 'request')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80) || 'request'

const SQL_USAGE = `
  SELECT COALESCE(SUM(bytes), 0) AS bytes FROM media
   WHERE deleted_at IS NULL AND availability = 'available'`

const SQL_ACTIVATE = `
  UPDATE media
     SET deleted_at = NULL,
         availability = 'available',
         unlink_attempts = 0,
         unlink_error = NULL,
         unlink_retry_after = NULL,
         availability_checked_at = ?
   WHERE id = ? AND (deleted_at IS NOT NULL OR availability <> 'available')`

const usageBytes = (db) => Number(db.get(SQL_USAGE)?.bytes) || 0

/**
 * Coordinates SQLite quota reservations with filesystem publication.
 *
 * SQLite and the filesystem cannot share a transaction. We therefore reserve
 * the row under BEGIN IMMEDIATE first, publish the file atomically with rename,
 * and compensate the reservation if publication fails. Reconciliation covers
 * the only remaining crash window: a committed row whose rename never ran.
 */
export const createMediaStorage = ({
  db,
  mediaDirectory,
  temporaryDirectory,
  quotaBytes,
  fs = DEFAULT_FS,
} = {}) => {
  if (!db?.transaction) throw new TypeError('media storage requires db')
  if (!mediaDirectory || !temporaryDirectory) {
    throw new TypeError('media storage requires media and temporary directories')
  }
  if (typeof quotaBytes !== 'function') throw new TypeError('media storage requires quotaBytes()')

  const readQuota = () => {
    const quota = Number(quotaBytes())
    if (!Number.isSafeInteger(quota) || quota <= 0) {
      throw new Error('media quota is not a positive safe integer')
    }
    return quota
  }

  const byId = (id) => db.get('SELECT * FROM media WHERE id = ?', [id])
  const bySha = (sha256) => db.get('SELECT * FROM media WHERE sha256 = ?', [sha256])

  /**
   * CR-034 step 2-4: the cost of restoring a row, evaluated without writing.
   * Over quota the caller returns `quota` and the database stays untouched.
   */
  const assess = (row) => {
    const usedBytes = usageBytes(db)
    const quota = readQuota()
    const requiredBytes = Number(row.bytes) || 0
    if (usedBytes + requiredBytes > quota) {
      return { kind: 'quota', usedBytes, quotaBytes: quota, requiredBytes }
    }
    return { kind: 'restorable', usedBytes, quotaBytes: quota, requiredBytes }
  }

  const markMissing = (id, now) => {
    db.run(
      `UPDATE media
          SET availability = 'missing',
              deleted_at = COALESCE(deleted_at, ?),
              availability_checked_at = ?
        WHERE id = ?`,
      [now, now, id]
    )
  }

  /**
   * Undoes a publication this call performed, unless the row became active in
   * the meantime — a concurrent restore that won the race now depends on the
   * very file we would delete (CR-034 criterion 9 outranks criterion 10).
   *
   * @returns {'removed'|'kept'|'unknown'}
   */
  const rollbackPublication = async (sha256, finalPath) => {
    let row
    try {
      row = bySha(sha256)
    } catch {
      // The database is unreachable, so ownership of the file cannot be
      // established. Reconciliation removes the file as an aged orphan; an
      // active row left without its file would not be recoverable at all.
      return 'unknown'
    }
    if (isActive(row)) return 'kept'
    await removeIfPresent(finalPath, fs)
    return 'removed'
  }

  /**
   * Reactivates a soft-deleted or missing media row in the strict CR-034 order:
   * locate by SHA, price the restore against the quota, make sure a file
   * exists, and only then flip the row inside a transaction.
   *
   * @param {{sha256: string, publishFrom?: string|null, now?: number}} options
   *   `publishFrom` is a temporary file holding the same content; it is used
   *   only when the published file is gone.
   * @returns {Promise<{kind: 'restored'|'active'|'quota'|'not_found'|'file_missing', row?: object}>}
   */
  const restore = async ({ sha256, publishFrom = null, now = Date.now() }) => {
    // 1. Locate the record.
    const found = bySha(sha256)
    if (!found) return { kind: 'not_found' }
    if (isActive(found)) return { kind: 'active', row: found }

    // 2-4. Quota first, still without a single write.
    const preflight = db.transaction(() => assess(found))
    if (preflight.kind === 'quota') return preflight

    const finalPath = join(mediaDirectory, found.filename)

    // 5. Is there a file to activate?
    const state = await inspect(finalPath, fs)
    let published = false
    if (!state.present) {
      if (state.reason === 'unreadable') throw state.error
      // 6. Republish from the temporary upload before touching the database.
      if (!publishFrom) {
        markMissing(found.id, now)
        return { kind: 'file_missing', row: byId(found.id), reason: state.reason }
      }
      await fs.mkdir(mediaDirectory, { recursive: true })
      // rename() refuses an existing destination on Windows, and a symlink
      // squatting on the name must not survive the publication anyway.
      if (state.reason !== 'absent') await removeIfPresent(finalPath, fs)
      await fs.rename(publishFrom, finalPath)
      published = true
    }

    // 7. Activate transactionally, re-reading quota under the write lock.
    let activation
    try {
      activation = db.transaction(() => {
        const row = bySha(sha256)
        if (!row) return { kind: 'not_found' }
        if (isActive(row)) return { kind: 'active', row }

        const priced = assess(row)
        if (priced.kind === 'quota') return priced

        // 11. Conditional update: the loser of a concurrent restore sees
        // changes === 0 and reports the winner's row instead of activating
        // twice.
        if (db.run(SQL_ACTIVATE, [now, row.id]).changes !== 1) {
          return { kind: 'active', row: byId(row.id) }
        }
        return { kind: 'restored', row: byId(row.id) }
      })
    } catch (error) {
      // 8/10. A database failure must not leave our file published.
      if (published) await rollbackPublication(sha256, finalPath)
      throw error
    }

    if (published && activation.kind !== 'restored') {
      await rollbackPublication(sha256, finalPath)
    }
    return activation
  }

  /**
   * Confirms that an already active row still has its file, republishing the
   * freshly uploaded copy when it does not. Usage accounting already includes
   * this row, so no quota decision is involved.
   */
  const adoptActive = async (row, tempPath, now) => {
    const finalPath = join(mediaDirectory, row.filename)
    const state = await inspect(finalPath, fs)
    if (state.present) {
      await removeIfPresent(tempPath, fs)
      return { kind: 'duplicate', row }
    }
    if (state.reason === 'unreadable') {
      await removeIfPresent(tempPath, fs)
      throw state.error
    }
    if (state.reason === 'symlink' || state.reason === 'not_a_file') {
      await removeIfPresent(finalPath, fs)
    }
    await fs.rename(tempPath, finalPath)
    db.run('UPDATE media SET availability_checked_at = ? WHERE id = ?', [now, row.id])
    return { kind: 'duplicate', row: byId(row.id) }
  }

  const upload = async ({
    buffer,
    filename,
    originalName,
    mime,
    width,
    height,
    sha256,
    userId,
    requestId,
    now = Date.now(),
  }) => {
    const tempName = `${safeRequestId(requestId)}-${randomUUID()}.part`
    const tempPath = join(temporaryDirectory, tempName)
    const finalPath = join(mediaDirectory, filename)

    await fs.mkdir(mediaDirectory, { recursive: true })
    await fs.mkdir(temporaryDirectory, { recursive: true })
    await fs.writeFile(tempPath, buffer)

    let reservation
    try {
      reservation = db.transaction(() => {
        // No write happens on the existing-row branch any more: reactivating a
        // soft-deleted row here was CR-034 — it cleared `deleted_at` before the
        // quota and the file had been checked.
        const existing = bySha(sha256)
        if (existing) return { kind: 'existing', row: existing }

        const usedBytes = usageBytes(db)
        const quota = readQuota()
        if (usedBytes + buffer.length > quota) {
          return { kind: 'quota', usedBytes, quotaBytes: quota }
        }

        const info = db.run(
          `INSERT INTO media
             (filename, original_name, mime, bytes, width, height, sha256, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            filename,
            String(originalName || 'upload').slice(0, 200),
            mime,
            buffer.length,
            width,
            height,
            sha256,
            userId ?? null,
            now,
          ]
        )
        return { kind: 'reserved', row: byId(Number(info.lastInsertRowid)) }
      })
    } catch (error) {
      await removeIfPresent(tempPath, fs)
      throw error
    }

    if (reservation.kind === 'quota') {
      await removeIfPresent(tempPath, fs)
      return reservation
    }

    if (reservation.kind === 'existing') {
      if (isActive(reservation.row)) {
        // A previous process may have committed its reservation immediately
        // before publishing the file. If it is still missing, this identical
        // content safely completes that publication.
        try {
          return await adoptActive(reservation.row, tempPath, now)
        } catch (error) {
          await removeIfPresent(tempPath, fs)
          throw error
        }
      }

      let outcome
      try {
        outcome = await restore({ sha256, publishFrom: tempPath, now })
      } catch (error) {
        await removeIfPresent(tempPath, fs)
        throw error
      }
      // restore() consumed the part on publication; anything left is a copy the
      // row did not need.
      await removeIfPresent(tempPath, fs)

      if (outcome.kind === 'restored') return { kind: 'restored', row: outcome.row }
      if (outcome.kind === 'active') return { kind: 'duplicate', row: outcome.row }
      return outcome
    }

    try {
      await fs.rename(tempPath, finalPath)
    } catch (error) {
      db.transaction(() => {
        db.run('DELETE FROM media WHERE id = ? AND sha256 = ?', [reservation.row.id, sha256])
      })
      await removeIfPresent(tempPath, fs)
      throw error
    }

    return reservation
  }

  const { collect, purge } = createMediaCollector({ db, mediaDirectory, fs })

  return { upload, restore, collect, purge }
}
