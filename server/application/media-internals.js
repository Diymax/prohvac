import { lstat, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'

/**
 * Primitives shared by the two halves of media storage.
 *
 * CR-059 split upload/restore (`media-storage.js`) from collection and
 * reconciliation (`media-gc.js`). Everything both halves need lives here so the
 * split does not create a cycle: neither half may import the other.
 */

/**
 * Availability of the file behind a media row.
 *
 * `deleted_at` alone cannot express the difference between "an editor deleted
 * this on purpose" and "the file vanished from disk", yet the two need opposite
 * handling: the first is collected after the grace period, the second must be
 * surfaced for recovery. See migration 008_media_availability.sql.
 */
export const MEDIA_AVAILABILITY = Object.freeze({
  AVAILABLE: 'available',
  MISSING: 'missing',
  PENDING_DELETE: 'pending_delete',
  DELETED: 'deleted',
})

export const DEFAULT_FS = { lstat, mkdir, readdir, rename, stat, unlink, writeFile }

export const removeIfPresent = async (path, fs) => {
  try {
    await fs.unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Inspects a path without ever following a symlink.
 *
 * `stat` resolves the link target, so a symlink planted in the media directory
 * would be reported as a healthy file and later served from `/media/` — an
 * arbitrary file read. `lstat` describes the link itself, and anything that is
 * not a regular file counts as "no file here".
 */
export const inspect = async (path, fs) => {
  try {
    const info = await (fs.lstat ?? fs.stat).call(fs, path)
    if (info.isSymbolicLink?.()) return { present: false, reason: 'symlink' }
    if (!info.isFile?.()) return { present: false, reason: 'not_a_file' }
    return { present: true, info }
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, reason: 'absent' }
    return { present: false, reason: 'unreadable', error }
  }
}

export const isActive = (row) =>
  Boolean(row) && row.deleted_at == null && row.availability === MEDIA_AVAILABILITY.AVAILABLE
