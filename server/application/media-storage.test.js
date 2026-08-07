import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
  mkdir,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import {
  createMediaStorage,
  MEDIA_AVAILABILITY,
  reconcileMediaStorage,
} from './media-storage.js'

const realFs = { lstat, mkdir, readdir, rename, stat, unlink, writeFile }

const DAY_MS = 24 * 60 * 60_000

// A directory entry as node:fs returns it with withFileTypes: the reconciler
// decides on isFile()/isSymbolicLink(), so fault injection has to speak Dirent.
const dirent = (name, { file = true, symlink = false } = {}) => ({
  name,
  isFile: () => file,
  isSymbolicLink: () => symlink,
  isDirectory: () => false,
})

const errno = (code) => Object.assign(new Error(`injected ${code}`), { code })

describe('atomic media storage', () => {
  let db
  let root
  let mediaDirectory
  let temporaryDirectory

  beforeEach(async () => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    root = await mkdtemp(join(tmpdir(), 'prohvac-media-'))
    mediaDirectory = join(root, 'media')
    temporaryDirectory = join(root, 'tmp')
  })

  afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const input = (text = 'image-content') => {
    const buffer = Buffer.from(text)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    return {
      buffer,
      filename: `${sha256.slice(0, 16)}.png`,
      originalName: 'photo.png',
      mime: 'image/png',
      width: 10,
      height: 10,
      sha256,
      requestId: 'req-test',
    }
  }

  const storage = (overrides = {}) =>
    createMediaStorage({
      db,
      mediaDirectory,
      temporaryDirectory,
      quotaBytes: () => 1024,
      ...overrides,
    })

  const rowOf = (id) => db.get('SELECT * FROM media WHERE id = ?', [id])

  // Exactly what the DELETE /api/admin/media/:id route writes.
  const softDelete = (id, at = Date.now()) =>
    db.run(`UPDATE media SET deleted_at = ?, availability = 'pending_delete' WHERE id = ?`, [
      at,
      id,
    ])

  const exists = async (path) => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  // Fails every db.transaction() after `skip` successful ones, so a specific
  // stage of a multi-transaction flow can be broken in isolation.
  const brokenAfter = (skip) => {
    let calls = 0
    return new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return (fn) => {
            calls += 1
            if (calls > skip) throw new Error('database unavailable')
            return target.transaction(fn)
          }
        }
        return Reflect.get(target, property)
      },
    })
  }

  it('publishes a reserved file and leaves no temporary part', async () => {
    const result = await storage().upload(input())

    expect(result.kind).toBe('reserved')
    expect(db.get('SELECT COUNT(*) AS n FROM media').n).toBe(1)
    expect(rowOf(result.row.id).availability).toBe(MEDIA_AVAILABILITY.AVAILABLE)
    await expect(readFile(join(mediaDirectory, result.row.filename))).resolves.toEqual(
      input().buffer
    )
    await expect(readdir(temporaryDirectory)).resolves.toEqual([])
  })

  it('deduplicates concurrent uploads by SHA without double quota usage', async () => {
    const [first, second] = await Promise.all([
      storage().upload(input('same-image')),
      storage().upload({ ...input('same-image'), requestId: 'req-second' }),
    ])

    expect(new Set([first.kind, second.kind])).toEqual(new Set(['reserved', 'duplicate']))
    expect(db.get('SELECT COUNT(*) AS n FROM media').n).toBe(1)
    expect(db.get('SELECT SUM(bytes) AS bytes FROM media').bytes).toBe(
      input('same-image').buffer.length
    )
  })

  it('reserves quota transactionally and stores nothing when exceeded', async () => {
    const result = await storage({ quotaBytes: () => 2 }).upload(input())

    expect(result).toMatchObject({ kind: 'quota', usedBytes: 0, quotaBytes: 2 })
    expect(db.get('SELECT COUNT(*) AS n FROM media').n).toBe(0)
    await expect(readdir(temporaryDirectory)).resolves.toEqual([])
  })

  it('removes the temporary file when the database reservation fails', async () => {
    await expect(storage({ db: brokenAfter(0) }).upload(input())).rejects.toThrow(
      'database unavailable'
    )
    await expect(readdir(temporaryDirectory)).resolves.toEqual([])
  })

  it('rolls back the row and temporary file when publication fails', async () => {
    const failingFs = { ...realFs, rename: async () => Promise.reject(errno('EIO')) }

    await expect(storage({ fs: failingFs }).upload(input())).rejects.toThrow('injected EIO')
    expect(db.get('SELECT COUNT(*) AS n FROM media').n).toBe(0)
    await expect(readdir(temporaryDirectory)).resolves.toEqual([])
  })

  it('reports missing referenced files and removes aged orphans and parts', async () => {
    const saved = await storage().upload(input())
    await unlink(join(mediaDirectory, saved.row.filename))
    await writeFile(join(mediaDirectory, 'orphan.png'), Buffer.from('orphan'))
    await writeFile(join(temporaryDirectory, 'abandoned.part'), Buffer.from('part'))
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    await utimes(join(mediaDirectory, 'orphan.png'), old, old)
    await utimes(join(temporaryDirectory, 'abandoned.part'), old, old)

    const result = await reconcileMediaStorage({
      db,
      mediaDirectory,
      temporaryDirectory,
      orphanGraceMs: 1000,
      tempGraceMs: 1000,
    })

    expect(result).toMatchObject({ removedOrphans: 1, removedTemps: 1 })
    expect(result.missing).toEqual([{ id: saved.row.id, filename: saved.row.filename }])
    await expect(readdir(mediaDirectory)).resolves.toEqual([])
    await expect(readdir(temporaryDirectory)).resolves.toEqual([])
  })

  // -------------------------------------------------------------------------
  // CR-034 — safe restore of soft-deleted media
  // -------------------------------------------------------------------------

  describe('CR-034 restore', () => {
    it('restores a soft-deleted row within quota and puts its bytes back in use', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id)
      expect(db.get('SELECT COALESCE(SUM(bytes),0) AS b FROM media WHERE deleted_at IS NULL').b)
        .toBe(0)

      const result = await storage().restore({ sha256: input().sha256 })

      expect(result.kind).toBe('restored')
      const row = rowOf(saved.row.id)
      expect(row.deleted_at).toBeNull()
      expect(row.availability).toBe(MEDIA_AVAILABILITY.AVAILABLE)
      expect(
        db.get(
          `SELECT COALESCE(SUM(bytes),0) AS b FROM media
            WHERE deleted_at IS NULL AND availability = 'available'`
        ).b
      ).toBe(input().buffer.length)
    })

    it('returns quota_exceeded above the quota and changes nothing in the database', async () => {
      const first = await storage().upload(input())
      softDelete(first.row.id)
      await storage().upload(input('other-image'))

      const used = input('other-image').buffer.length
      const before = rowOf(first.row.id)
      const result = await storage({
        quotaBytes: () => used + input().buffer.length - 1,
      }).restore({ sha256: input().sha256 })

      expect(result).toMatchObject({ kind: 'quota', usedBytes: used })
      expect(rowOf(first.row.id)).toEqual(before)
      // The file is untouched too: nothing was published and nothing removed.
      await expect(exists(join(mediaDirectory, first.row.filename))).resolves.toBe(true)
    })

    it('never activates a row whose physical file is gone', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id)
      await unlink(join(mediaDirectory, saved.row.filename))

      const result = await storage().restore({ sha256: input().sha256 })

      expect(result.kind).toBe('file_missing')
      const row = rowOf(saved.row.id)
      expect(row.availability).toBe(MEDIA_AVAILABILITY.MISSING)
      expect(row.deleted_at).not.toBeNull()
    })

    it('republishes the temporary upload before activating a row without a file', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id)
      await unlink(join(mediaDirectory, saved.row.filename))

      const result = await storage().upload({ ...input(), requestId: 'req-again' })

      expect(result.kind).toBe('restored')
      expect(rowOf(saved.row.id).availability).toBe(MEDIA_AVAILABILITY.AVAILABLE)
      expect(rowOf(saved.row.id).deleted_at).toBeNull()
      await expect(readFile(join(mediaDirectory, saved.row.filename))).resolves.toEqual(
        input().buffer
      )
      await expect(readdir(temporaryDirectory)).resolves.toEqual([])
    })

    it('leaves the row inactive when republication fails on rename', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id)
      await unlink(join(mediaDirectory, saved.row.filename))

      const failingFs = { ...realFs, rename: async () => Promise.reject(errno('EIO')) }
      await expect(
        storage({ fs: failingFs }).upload({ ...input(), requestId: 'req-again' })
      ).rejects.toThrow('injected EIO')

      const row = rowOf(saved.row.id)
      expect(row.deleted_at).not.toBeNull()
      expect(row.availability).toBe(MEDIA_AVAILABILITY.PENDING_DELETE)
      await expect(readdir(mediaDirectory)).resolves.toEqual([])
      await expect(readdir(temporaryDirectory)).resolves.toEqual([])
    })

    it('removes the published file when the activation transaction fails', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id)
      await unlink(join(mediaDirectory, saved.row.filename))

      // Transactions in this flow: reservation lookup, quota preflight,
      // activation. Only the last one is broken.
      await expect(
        storage({ db: brokenAfter(2) }).upload({ ...input(), requestId: 'req-again' })
      ).rejects.toThrow('database unavailable')

      const row = rowOf(saved.row.id)
      expect(row.deleted_at).not.toBeNull()
      expect(row.availability).toBe(MEDIA_AVAILABILITY.PENDING_DELETE)
      // No orphan file and no stranded temporary part.
      await expect(readdir(mediaDirectory)).resolves.toEqual([])
      await expect(readdir(temporaryDirectory)).resolves.toEqual([])
    })

    it('activates exactly once when the same SHA is restored concurrently', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id)

      const results = await Promise.all([
        storage().restore({ sha256: input().sha256 }),
        storage().restore({ sha256: input().sha256 }),
      ])

      expect(results.filter((item) => item.kind === 'restored')).toHaveLength(1)
      expect(results.filter((item) => item.kind === 'active')).toHaveLength(1)
      expect(rowOf(saved.row.id).availability).toBe(MEDIA_AVAILABILITY.AVAILABLE)
      await expect(exists(join(mediaDirectory, saved.row.filename))).resolves.toBe(true)
    })

    it('treats a repeated upload of active media as a duplicate without a restore', async () => {
      const saved = await storage().upload(input())

      const again = await storage().upload({ ...input(), requestId: 'req-again' })

      expect(again.kind).toBe('duplicate')
      expect(again.row.id).toBe(saved.row.id)
      expect(db.get('SELECT COUNT(*) AS n FROM media').n).toBe(1)
      await expect(readdir(temporaryDirectory)).resolves.toEqual([])
    })

    it('reports not_found for an unknown SHA', async () => {
      await expect(storage().restore({ sha256: 'a'.repeat(64) })).resolves.toEqual({
        kind: 'not_found',
      })
    })
  })

  // -------------------------------------------------------------------------
  // CR-037 — collection and the missing-file state
  // -------------------------------------------------------------------------

  describe('CR-037 collection and availability', () => {
    const aged = () => Date.now() - 8 * DAY_MS

    it('keeps the row and records retry metadata when unlink fails with EACCES', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id, aged())

      const failingFs = { ...realFs, unlink: async () => Promise.reject(errno('EACCES')) }
      const now = Date.now()
      const result = await storage({ fs: failingFs }).collect({ now })

      expect(result.removed).toBe(0)
      expect(result.retained).toEqual([
        {
          kind: 'retained',
          id: saved.row.id,
          filename: saved.row.filename,
          code: 'EACCES',
          attempts: 1,
          retryAfter: expect.any(Number),
        },
      ])

      const row = rowOf(saved.row.id)
      expect(row).toBeTruthy()
      expect(row.availability).toBe(MEDIA_AVAILABILITY.PENDING_DELETE)
      expect(row.unlink_attempts).toBe(1)
      expect(row.unlink_error).toBe('EACCES')
      expect(row.unlink_retry_after).toBeGreaterThan(now)
      // The file that could not be unlinked is still there and still accounted.
      await expect(exists(join(mediaDirectory, saved.row.filename))).resolves.toBe(true)
    })

    it.each(['EPERM', 'EBUSY', 'EIO'])('keeps the row when unlink fails with %s', async (code) => {
      const saved = await storage().upload(input(`content-${code}`))
      softDelete(saved.row.id, aged())

      const failingFs = { ...realFs, unlink: async () => Promise.reject(errno(code)) }
      const result = await storage({ fs: failingFs }).collect({ now: Date.now() })

      expect(result.removed).toBe(0)
      expect(result.retained[0].code).toBe(code)
      expect(rowOf(saved.row.id)).toBeTruthy()
    })

    it('does not retry before the recorded deadline', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id, aged())

      const unlinkSpy = vi.fn(async () => Promise.reject(errno('EBUSY')))
      const failingStorage = storage({ fs: { ...realFs, unlink: unlinkSpy } })
      const now = Date.now()
      await failingStorage.collect({ now })
      await failingStorage.collect({ now: now + 1000 })

      expect(unlinkSpy).toHaveBeenCalledTimes(1)
      expect(rowOf(saved.row.id).unlink_attempts).toBe(1)
    })

    it('removes the row when the file is already gone (ENOENT)', async () => {
      const saved = await storage().upload(input())
      await unlink(join(mediaDirectory, saved.row.filename))
      softDelete(saved.row.id, aged())

      const result = await storage().collect({ now: Date.now() })

      expect(result).toMatchObject({ removed: 1, retained: [] })
      expect(rowOf(saved.row.id)).toBeUndefined()
    })

    it('removes both the file and the row on a successful unlink', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id, aged())

      const result = await storage().collect({ now: Date.now() })

      expect(result.removed).toBe(1)
      expect(rowOf(saved.row.id)).toBeUndefined()
      await expect(readdir(mediaDirectory)).resolves.toEqual([])
    })

    it('leaves the row in the deleted state when the row delete itself fails', async () => {
      const first = await storage().upload(input())
      const second = await storage().upload(input('second-image'))
      softDelete(first.row.id, aged())
      softDelete(second.row.id, aged())

      const brokenDelete = new Proxy(db, {
        get(target, property) {
          if (property === 'run') {
            return (sql, params) => {
              if (String(sql).trim().startsWith('DELETE FROM media')) {
                throw new Error('row delete failed')
              }
              return target.run(sql, params)
            }
          }
          return Reflect.get(target, property)
        },
      })

      const result = await storage({ db: brokenDelete }).collect({ now: Date.now() })

      // Both files are gone from disk, both rows survive as `deleted`, and one
      // bad row did not stop the other from being processed.
      expect(result.removed).toBe(0)
      expect(result.retained).toHaveLength(2)
      expect(rowOf(first.row.id).availability).toBe(MEDIA_AVAILABILITY.DELETED)
      expect(rowOf(second.row.id).availability).toBe(MEDIA_AVAILABILITY.DELETED)
      await expect(readdir(mediaDirectory)).resolves.toEqual([])

      // The next pass finds ENOENT and finishes the job.
      const retry = await storage().collect({ now: Date.now() })
      expect(retry.removed).toBe(2)
      expect(rowOf(first.row.id)).toBeUndefined()
    })

    it('never collects a row that content still references', async () => {
      const saved = await storage().upload(input())
      softDelete(saved.row.id, aged())
      db.run('INSERT INTO projects (slug, cover_media_id, status) VALUES (?, ?, ?)', [
        'demo',
        saved.row.id,
        'published',
      ])

      const result = await storage().collect({ now: Date.now() })

      expect(result.removed).toBe(0)
      expect(rowOf(saved.row.id)).toBeTruthy()
    })

    it('moves a vanished file to missing and unpublishes it', async () => {
      const saved = await storage().upload(input())
      db.run('INSERT INTO projects (slug, cover_media_id, status) VALUES (?, ?, ?)', [
        'demo',
        saved.row.id,
        'published',
      ])
      await unlink(join(mediaDirectory, saved.row.filename))

      const result = await reconcileMediaStorage({ db, mediaDirectory, temporaryDirectory })

      expect(result.missing).toEqual([{ id: saved.row.id, filename: saved.row.filename }])
      const row = rowOf(saved.row.id)
      expect(row.availability).toBe(MEDIA_AVAILABILITY.MISSING)
      expect(row.deleted_at).not.toBeNull()

      // The gate every public content query uses: a missing file can no longer
      // produce a working /media/ URL.
      const published = db.get(
        `SELECT m.filename FROM projects p
          LEFT JOIN media m ON m.id = p.cover_media_id AND m.deleted_at IS NULL
          WHERE p.status = 'published'`
      )
      expect(published.filename).toBeNull()
    })

    it('leaves the state alone when the file cannot be read', async () => {
      const saved = await storage().upload(input())

      const result = await reconcileMediaStorage({
        db,
        mediaDirectory,
        temporaryDirectory,
        fs: { ...realFs, lstat: async () => Promise.reject(errno('EACCES')) },
      })

      expect(result.missing).toEqual([])
      expect(result.unreadable).toEqual([
        { id: saved.row.id, filename: saved.row.filename, code: 'EACCES' },
      ])
      expect(rowOf(saved.row.id).availability).toBe(MEDIA_AVAILABILITY.AVAILABLE)
    })

    it('treats a symlink standing in for a media file as missing', async () => {
      const saved = await storage().upload(input())
      const linkStat = {
        isSymbolicLink: () => true,
        isFile: () => false,
        mtimeMs: Date.now(),
      }

      const result = await reconcileMediaStorage({
        db,
        mediaDirectory,
        temporaryDirectory,
        fs: { ...realFs, lstat: async () => linkStat },
      })

      expect(result.missing).toEqual([{ id: saved.row.id, filename: saved.row.filename }])
      expect(rowOf(saved.row.id).availability).toBe(MEDIA_AVAILABILITY.MISSING)
    })

    it('never unlinks a symlink found during orphan cleanup', async () => {
      const unlinkSpy = vi.fn(realFs.unlink)
      const fs = {
        ...realFs,
        unlink: unlinkSpy,
        readdir: async (dir) =>
          dir === mediaDirectory ? [dirent('evil.png', { file: false, symlink: true })] : [],
      }

      const result = await reconcileMediaStorage({
        db,
        mediaDirectory,
        temporaryDirectory,
        fs,
        orphanGraceMs: 0,
      })

      expect(result.symlinks).toEqual(['evil.png'])
      expect(result.removedOrphans).toBe(0)
      expect(unlinkSpy).not.toHaveBeenCalled()
    })

    it('records a permission error on one orphan and still removes the others', async () => {
      await mkdir(mediaDirectory, { recursive: true })
      await writeFile(join(mediaDirectory, 'locked.png'), Buffer.from('locked'))
      await writeFile(join(mediaDirectory, 'free.png'), Buffer.from('free'))
      const old = new Date(Date.now() - 48 * 60 * 60_000)
      await utimes(join(mediaDirectory, 'locked.png'), old, old)
      await utimes(join(mediaDirectory, 'free.png'), old, old)

      const fs = {
        ...realFs,
        stat: async (path) => {
          if (String(path).endsWith('locked.png')) throw errno('EACCES')
          return stat(path)
        },
      }

      const result = await reconcileMediaStorage({
        db,
        mediaDirectory,
        temporaryDirectory,
        fs,
        orphanGraceMs: 1000,
      })

      expect(result.removedOrphans).toBe(1)
      expect(result.orphanFailures).toEqual([{ filename: 'locked.png', code: 'EACCES' }])
      await expect(readdir(mediaDirectory)).resolves.toEqual(['locked.png'])
    })

    it('purges a missing row only when nothing references it', async () => {
      const saved = await storage().upload(input())
      await unlink(join(mediaDirectory, saved.row.filename))
      await reconcileMediaStorage({ db, mediaDirectory, temporaryDirectory })

      db.run('INSERT INTO partners (name, media_id) VALUES (?, ?)', ['acme', saved.row.id])
      await expect(storage().purge({ id: saved.row.id })).resolves.toEqual({ kind: 'in_use' })

      db.run('UPDATE partners SET media_id = NULL')
      await expect(storage().purge({ id: saved.row.id })).resolves.toEqual({ kind: 'purged' })
      expect(rowOf(saved.row.id)).toBeUndefined()
    })

    it('refuses to purge an active row and reports a failed unlink', async () => {
      const saved = await storage().upload(input())
      await expect(storage().purge({ id: saved.row.id })).resolves.toEqual({ kind: 'active' })

      softDelete(saved.row.id)
      const failingFs = { ...realFs, unlink: async () => Promise.reject(errno('EBUSY')) }
      await expect(storage({ fs: failingFs }).purge({ id: saved.row.id })).resolves.toEqual({
        kind: 'unlink_failed',
        code: 'EBUSY',
      })
      expect(rowOf(saved.row.id)).toBeTruthy()
    })
  })
})
