// Загрузка и учёт изображений.
//
// Файл приходит уже сжатым: админка ужимает его в браузере (canvas → WebP),
// потому что sharp на сервере — это десятки мегабайт нативных бинарников
// при общей квоте хостинга в 500 МБ, и нет гарантии, что он там соберётся.
// Но клиенту не верим ни в чём: тип определяется по сигнатуре файла,
// размеры — по заголовку, имя на диске генерирует сервер.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { SETTINGS_REGISTRY, SETTING_KEYS } from '../../shared/settings.js'
import {
  createMediaStorage,
  MEDIA_AVAILABILITY,
  reconcileMediaStorage,
} from '../application/media-storage.js'
import { verifyCsrf } from '../auth/csrf.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { json } from '../http/respond.js'
import { readMultipart } from '../http/multipart.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { contentAddressedName, validateUpload } from '../lib/image.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'
import { readSetting } from './admin.settings.js'

// Потолок выше «целевых 150 КБ»: сложный кадр браузер может не ужать до цели,
// и отвергать его из-за 40 лишних килобайт значило бы ломать работу редактору.
const MAX_UPLOAD_BYTES = 400 * 1024
const MAX_DIMENSION = 1920
const TARGET_UPLOAD_BYTES = 150 * 1024
const ALLOWED_MIME_TYPES = Object.freeze([
  'image/webp',
  'image/avif',
  'image/jpeg',
  'image/png',
])
const ALLOWED_EXTENSIONS = Object.freeze(['.webp', '.avif', '.jpg', '.jpeg', '.png'])

const UPLOAD_WINDOW_MS = 60_000
const UPLOAD_MAX = 30

const mediaDir = () => join(config.dataDir, 'media')
const tmpDir = () => join(config.dataDir, 'tmp')

export const resolveMediaQuota = (db) => {
  const bounds = SETTINGS_REGISTRY[SETTING_KEYS.MEDIA_QUOTA_BYTES]
  const stored = Number(readSetting(db, SETTING_KEYS.MEDIA_QUOTA_BYTES))
  return Number.isSafeInteger(stored) && stored >= bounds.min && stored <= bounds.max
    ? stored
    : config.mediaQuotaBytes
}

// Учитываются только доступные файлы: строка со статусом missing указывает
// на файл, которого на диске нет, и включать её вес в занятое место значило бы
// запретить загрузку ради байтов, которых никто не занимает.
// CR-047. Разбор параметров списка медиатеки.
//
// Всё, что приходит из строки запроса, попадает в SQL только плейсхолдерами,
// а сюда — только после проверки формы. Курсор — та же пара
// «created_at, id», что и у заявок: позиция в порядке сортировки, а не
// смещение, поэтому страницы не разъезжаются при одинаковых отметках времени.
// Размер страницы по умолчанию намеренно равен прежнему жёсткому LIMIT 500:
// текущая админка запрашивает список без параметров и должна увидеть ровно то
// же, что видела раньше. Новое здесь не в уменьшении выдачи, а в том, что
// файлы за пределами первых пятисот вообще перестали быть недостижимыми —
// за ними теперь можно сходить по курсору.
const MEDIA_DEFAULT_LIMIT = 500
const MEDIA_MAX_LIMIT = 500
const MEDIA_SEARCH_MAX = 100
const MEDIA_MIME_PATTERN = /^[a-z]+\/[a-z0-9.+-]{1,60}$/
const MEDIA_CURSOR_PATTERN = /^(\d{1,15})\.(\d{1,15})$/

/** Экранирует служебные символы LIKE: без этого '%' из ввода выбирает всю таблицу. */
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const mediaQuery = (req) => {
  const url = typeof req.url === 'string' ? req.url : ''
  const mark = url.indexOf('?')
  const params = new URLSearchParams(mark === -1 ? '' : url.slice(mark + 1).split('#')[0])

  const rawLimit = (params.get('limit') || '').trim()
  let limit = MEDIA_DEFAULT_LIMIT
  if (rawLimit) {
    if (!/^\d{1,4}$/.test(rawLimit)) return { ok: false, error: 'invalid_pagination' }
    limit = Number(rawLimit)
    if (limit < 1 || limit > MEDIA_MAX_LIMIT) return { ok: false, error: 'invalid_pagination' }
  }

  const search = (params.get('search') || '').trim()
  if (search.length > MEDIA_SEARCH_MAX) return { ok: false, error: 'invalid_search' }

  const mime = (params.get('mime') || '').trim().toLowerCase()
  if (mime && !MEDIA_MIME_PATTERN.test(mime)) return { ok: false, error: 'invalid_mime' }

  const bound = (name) => {
    const raw = (params.get(name) || '').trim()
    if (!raw) return null
    if (!/^\d{1,15}$/.test(raw)) return undefined
    return Number(raw)
  }
  const since = bound('since')
  const until = bound('until')
  if (since === undefined || until === undefined) return { ok: false, error: 'invalid_range' }

  const rawCursor = (params.get('cursor') || '').trim()
  let cursor = null
  if (rawCursor) {
    const match = MEDIA_CURSOR_PATTERN.exec(rawCursor)
    if (!match) return { ok: false, error: 'invalid_pagination' }
    cursor = { createdAt: Number(match[1]), id: Number(match[2]) }
    if (!Number.isSafeInteger(cursor.createdAt) || !Number.isSafeInteger(cursor.id)) {
      return { ok: false, error: 'invalid_pagination' }
    }
  }

  return { ok: true, value: { limit, search, mime, since, until, cursor } }
}

const usageOf = (db) => {
  const row = db.get(
    `SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM media
      WHERE deleted_at IS NULL AND availability = 'available'`
  )
  const quotaBytes = resolveMediaQuota(db)
  const usedBytes = Number(row?.bytes) || 0
  return {
    usedBytes,
    quotaBytes,
    count: Number(row?.count) || 0,
    percent: quotaBytes ? Math.round((usedBytes / quotaBytes) * 100) : 0,
  }
}

const capabilitiesOf = (db) => {
  const usage = usageOf(db)
  return {
    maxBytes: MAX_UPLOAD_BYTES,
    maxDimension: MAX_DIMENSION,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
    allowedExtensions: ALLOWED_EXTENSIONS,
    remainingQuotaBytes: Math.max(0, usage.quotaBytes - usage.usedBytes),
    recommendation: {
      targetBytes: TARGET_UPLOAD_BYTES,
      preferredMimeType: 'image/webp',
      maxDimension: MAX_DIMENSION,
      fallbackDimension: 1280,
    },
  }
}

// Ссылка отдаётся только на файл, который на диске действительно есть:
// строка со статусом missing или pending_delete превратилась бы в битую
// картинку в админке и, что хуже, в рабочий на вид URL.
const isPublishable = (row) =>
  row.deleted_at == null && row.availability === MEDIA_AVAILABILITY.AVAILABLE

const toItem = (row) => ({
  id: row.id,
  url: isPublishable(row) ? `/media/${row.filename}` : null,
  filename: row.filename,
  originalName: row.original_name,
  mime: row.mime,
  bytes: row.bytes,
  width: row.width,
  height: row.height,
  createdAt: row.created_at,
  availability: row.availability ?? MEDIA_AVAILABILITY.AVAILABLE,
  deletedAt: row.deleted_at ?? null,
  unlinkError: row.unlink_error ?? null,
  unlinkAttempts: row.unlink_attempts ?? 0,
  unlinkRetryAfter: row.unlink_retry_after ?? null,
})

const storageFor = (db) =>
  createMediaStorage({
    db,
    mediaDirectory: mediaDir(),
    temporaryDirectory: tmpDir(),
    quotaBytes: () => resolveMediaQuota(db),
  })

/**
 * Физически удаляет то, что помечено удалённым давно и ни на что не ссылается.
 *
 * Строка снимается только после успешного unlink или ENOENT (CR-037): раньше
 * она удалялась при любом исходе, и EACCES/EBUSY терял единственную ссылку
 * на файл, продолжающий занимать квоту.
 *
 * @returns {Promise<{removed: number, retained: Array<object>}>}
 */
export const gcMedia = (db, now = Date.now()) => storageFor(db).collect({ now })

export const registerAdminMediaRoutes = (router, deps = {}) => {
  const { db } = deps
  if (!db) throw new TypeError('admin.media: нужен deps.db')

  const limiter = createRateLimiter(db)

  const guard = async (
    req,
    res,
    { mutating = false, upload = false, body = false, capability: requiredCapability } = {}
  ) => {
    const { ipHash, requestId } = ensureRequestContext(req)
    const access = requireActive(db, req)
    if (!access.ok) {
      await denyAsNotFound(req, res)
      return null
    }

    // Роль проверяется так же, как в остальных админских маршрутах.
    // Без этого viewer — по замыслу «смотрит, но не пишет» — мог удалять
    // обложки проектов и запускать физическую уборку файлов.
    const capability =
      requiredCapability ?? (mutating ? CAPABILITY.MEDIA_UPLOAD : CAPABILITY.MEDIA_READ)
    if (!hasCapability(access.user, capability)) {
      json(res, 403, { ok: false, error: 'forbidden' })
      return null
    }

    if (mutating) {
      // contentTypes обязателен и зависит от маршрута: загрузка приходит как
      // multipart, удаление и уборка — вовсе без тела. Раньше сюда передавался
      // весь config, у которого этого поля нет, и verifyCsrf брал умолчание
      // application/json — то есть ВСЕ мутации медиа отвечали 403 всегда.
      const csrf = verifyCsrf(req, access.session, {
        publicOrigin: config.publicOrigin,
        contentTypes: upload ? ['multipart/form-data'] : body ? ['application/json'] : null,
      })
      if (!csrf.ok) {
        const status = csrf.error === 'unsupported_media_type' ? 415 : 403
        json(res, status, { ok: false, error: csrf.error || 'csrf_failed' })
        return null
      }
    }
    return { ...access, ipHash, requestId }
  }

  // actor объявлен NOT NULL: раньше сюда писался NULL, вставка падала уже
  // ПОСЛЕ записи файла на диск, и клиент получал 500 на успешной операции —
  // повторял её, а в журнал не попадало ничего. Отсюда и try/catch:
  // неудача аудита не должна отменять выполненное действие, но обязана
  // оставить след в логе.
  const audit = (user, ipHash, action, entityId, meta) => {
    try {
      db.run(
        `INSERT INTO audit_log
          (at, user_id, actor, action, entity, entity_id, ip_hash, result, diff)
         VALUES (?, ?, ?, ?, 'media', ?, ?, 'ok', ?)`,
        [
          Date.now(),
          user?.id ?? null,
          user?.username ?? 'system',
          action,
          entityId == null ? null : String(entityId),
          ipHash,
          JSON.stringify(meta ?? {}),
        ]
      )
    } catch (error) {
      console.error(`[media] аудит не записан (${action}): ${error.message}`)
    }
  }

  const storage = storageFor(db)

  router.register('POST', '/api/admin/media', async (req, res) => {
    const access = await guard(req, res, { mutating: true, upload: true })
    if (!access) return

    // Лимит по сессии, а не по IP: у редакторов один офис и один внешний адрес,
    // и общий лимит превратился бы в очередь друг за другом.
    const rate = limiter.hit(`media:${access.session.id}`, {
      windowMs: UPLOAD_WINDOW_MS,
      max: UPLOAD_MAX,
    })
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((rate.resetAt - Date.now()) / 1000)))
      json(res, 429, { ok: false, error: 'rate_limited' })
      return
    }

    const parsed = await readMultipart(req, { maxFileBytes: MAX_UPLOAD_BYTES })
    if (!parsed.ok) {
      const status = parsed.error === 'payload_too_large' || parsed.error === 'file_too_large' ? 413 : 400
      json(res, status, { ok: false, error: parsed.error })
      return
    }
    if (!parsed.file?.buffer?.length) {
      json(res, 400, { ok: false, error: 'file_required' })
      return
    }

    const check = validateUpload(parsed.file.buffer, {
      maxBytes: MAX_UPLOAD_BYTES,
      maxWidth: MAX_DIMENSION,
      maxHeight: MAX_DIMENSION,
      allowedMimes: ALLOWED_MIME_TYPES,
    })
    if (!check.ok) {
      json(res, check.error === 'too_large' ? 413 : 415, { ok: false, error: check.error })
      return
    }

    const buffer = parsed.file.buffer
    const sha256 = createHash('sha256').update(buffer).digest('hex')

    const filename = contentAddressedName(buffer, check.meta.mime)
    let result
    try {
      result = await storage.upload({
        buffer,
        filename,
        originalName: parsed.file.filename,
        mime: check.meta.mime,
        width: check.meta.width,
        height: check.meta.height,
        sha256,
        userId: access.user?.id,
        requestId: access.requestId,
      })
    } catch (error) {
      console.error(`[media] upload failed request=${access.requestId}: ${error.message}`)
      json(res, 500, { ok: false, error: 'upload_failed' })
      return
    }

    if (result.kind === 'quota') {
      json(res, 507, { ok: false, error: 'quota_exceeded', usage: usageOf(db) })
      return
    }

    if (result.kind === 'duplicate') {
      json(res, 200, {
        ok: true,
        ...toItem(result.row),
        deduplicated: true,
        usage: usageOf(db),
      })
      return
    }

    // Повторная загрузка того же содержимого — штатный способ вернуть к жизни
    // мягко удалённый файл или файл, исчезнувший с диска: квота проверена,
    // файл опубликован, и только после этого строка стала активной.
    if (result.kind === 'restored') {
      audit(access.user, access.ipHash, 'media.restore', result.row.id, {
        via: 'upload',
        bytes: result.row.bytes,
      })
      json(res, 200, { ok: true, ...toItem(result.row), restored: true, usage: usageOf(db) })
      return
    }

    if (result.kind !== 'reserved') {
      // Гонка: строка исчезла между проверкой по SHA и восстановлением.
      // Повтор запроса пройдёт по обычному пути резервирования.
      console.error(`[media] unexpected upload outcome=${result.kind} request=${access.requestId}`)
      json(res, 409, { ok: false, error: 'upload_conflict' })
      return
    }

    audit(access.user, access.ipHash, 'media.upload', result.row.id, {
      bytes: buffer.length,
      mime: check.meta.mime,
    })

    json(res, 201, { ok: true, ...toItem(result.row), usage: usageOf(db) })
  })

  router.register('GET', '/api/admin/media', async (req, res) => {
    const access = await guard(req, res)
    if (!access) return

    // CR-047. Раньше здесь стоял единственный доступный режим — ORDER BY
    // created_at DESC LIMIT 500. Медиатека старше пятисот файлов просто
    // переставала быть доступной целиком, а искать в ней было нечем.
    const query = mediaQuery(req)
    if (!query.ok) {
      json(res, 400, { ok: false, error: query.error })
      return
    }

    const conditions = ["deleted_at IS NULL", "availability = 'available'"]
    const params = []
    if (query.value.search) {
      // LIKE по имени файла: экранируем служебные символы, иначе '%' из ввода
      // превращает поиск в выборку всей таблицы.
      conditions.push("filename LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(query.value.search)}%`)
    }
    if (query.value.mime) {
      conditions.push('mime = ?')
      params.push(query.value.mime)
    }
    if (query.value.since !== null) {
      conditions.push('created_at >= ?')
      params.push(query.value.since)
    }
    if (query.value.until !== null) {
      conditions.push('created_at <= ?')
      params.push(query.value.until)
    }
    if (query.value.cursor) {
      conditions.push('(created_at, id) < (?, ?)')
      params.push(query.value.cursor.createdAt, query.value.cursor.id)
    }

    const rows = db.all(
      `SELECT * FROM media
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, query.value.limit + 1]
    )
    const page = rows.slice(0, query.value.limit)
    const nextCursor =
      rows.length > query.value.limit && page.length > 0
        ? `${Number(page[page.length - 1].created_at)}.${Number(page[page.length - 1].id)}`
        : null
    // Проблемные строки едут отдельным списком, а не вперемешку с items:
    // items читает ещё и пикер медиатеки в разделе «Блоки», и файл без файла
    // на диске не должен предлагаться к выбору.
    const problems = db.all(
      `SELECT * FROM media
        WHERE availability <> 'available'
        ORDER BY COALESCE(deleted_at, created_at) DESC LIMIT 200`
    )
    json(res, 200, {
      ok: true,
      items: page.map(toItem),
      problems: problems.map(toItem),
      nextCursor,
      limit: query.value.limit,
      usage: usageOf(db),
      capabilities: capabilitiesOf(db),
    })
  })

  router.register('DELETE', '/api/admin/media/:id', async (req, res, params) => {
    const access = await guard(req, res, {
      mutating: true,
      capability: CAPABILITY.MEDIA_DELETE,
    })
    if (!access) return

    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      json(res, 400, { ok: false, error: 'invalid_id' })
      return
    }

    const row = db.get('SELECT id FROM media WHERE id = ? AND deleted_at IS NULL', [id])
    if (!row) {
      json(res, 404, { ok: false, error: 'not_found' })
      return
    }

    // Мягкое удаление: файл остаётся на диске неделю, чтобы случайную замену
    // можно было откатить, а закэшированные страницы не отдавали битые ссылки.
    db.run(
      `UPDATE media SET deleted_at = ?, availability = 'pending_delete' WHERE id = ?`,
      [Date.now(), id]
    )
    audit(access.user, access.ipHash, 'media.delete', id, {})

    json(res, 200, { ok: true, usage: usageOf(db) })
  })

  // Возврат мягко удалённого файла. Порядок шагов задан CR-034 и живёт
  // в storage.restore(): квота считается до любой записи, строка становится
  // активной только после того, как файл на диске подтверждён.
  router.register('POST', '/api/admin/media/:id/restore', async (req, res, params) => {
    const access = await guard(req, res, {
      mutating: true,
      capability: CAPABILITY.MEDIA_UPLOAD,
    })
    if (!access) return

    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      json(res, 400, { ok: false, error: 'invalid_id' })
      return
    }

    const row = db.get('SELECT sha256 FROM media WHERE id = ?', [id])
    if (!row) {
      json(res, 404, { ok: false, error: 'not_found' })
      return
    }

    let result
    try {
      result = await storage.restore({ sha256: row.sha256 })
    } catch (error) {
      console.error(`[media] restore failed id=${id} request=${access.requestId}: ${error.message}`)
      json(res, 500, { ok: false, error: 'restore_failed' })
      return
    }

    if (result.kind === 'quota') {
      json(res, 507, { ok: false, error: 'quota_exceeded', usage: usageOf(db) })
      return
    }
    if (result.kind === 'not_found') {
      json(res, 404, { ok: false, error: 'not_found' })
      return
    }
    if (result.kind === 'file_missing') {
      // Файла нет и восстанавливать нечего: строка помечена missing, и
      // единственный безопасный выход — загрузить файл заново либо удалить
      // запись окончательно.
      json(res, 409, {
        ok: false,
        error: 'file_missing',
        ...toItem(result.row),
        usage: usageOf(db),
      })
      return
    }

    if (result.kind === 'restored') {
      audit(access.user, access.ipHash, 'media.restore', id, { via: 'admin' })
    }
    json(res, 200, {
      ok: true,
      ...toItem(result.row),
      restored: result.kind === 'restored',
      usage: usageOf(db),
    })
  })

  // Окончательное удаление: применимо только к строке, которая уже не активна.
  router.register('POST', '/api/admin/media/:id/purge', async (req, res, params) => {
    const access = await guard(req, res, {
      mutating: true,
      capability: CAPABILITY.MEDIA_DELETE,
    })
    if (!access) return

    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      json(res, 400, { ok: false, error: 'invalid_id' })
      return
    }

    let result
    try {
      result = await storage.purge({ id })
    } catch (error) {
      console.error(`[media] purge failed id=${id} request=${access.requestId}: ${error.message}`)
      json(res, 500, { ok: false, error: 'purge_failed' })
      return
    }

    if (result.kind === 'not_found') {
      json(res, 404, { ok: false, error: 'not_found' })
      return
    }
    if (result.kind === 'active') {
      json(res, 409, { ok: false, error: 'still_active' })
      return
    }
    if (result.kind === 'in_use') {
      json(res, 409, { ok: false, error: 'still_referenced' })
      return
    }
    if (result.kind === 'unlink_failed') {
      console.warn(`[media] purge could not remove file id=${id}: ${result.code}`)
      json(res, 503, { ok: false, error: 'unlink_failed', code: result.code })
      return
    }

    audit(access.user, access.ipHash, 'media.purge', id, {})
    json(res, 200, { ok: true, usage: usageOf(db) })
  })

  router.register('POST', '/api/admin/media/gc', async (req, res) => {
    const access = await guard(req, res, {
      mutating: true,
      capability: CAPABILITY.MEDIA_DELETE,
    })
    if (!access) return

    const collected = await gcMedia(db)
    const reconciliation = await reconcileMediaStorage({
      db,
      mediaDirectory: mediaDir(),
      temporaryDirectory: tmpDir(),
    })

    // Предупреждения операционного уровня: каждая из этих трёх ситуаций
    // означает расхождение базы и диска, которое само не рассосётся.
    for (const entry of collected.retained) {
      console.warn(
        `[media] файл не удалён id=${entry.id} code=${entry.code} ` +
        `попыток=${entry.attempts} следующая=${new Date(entry.retryAfter).toISOString()}`
      )
    }
    if (reconciliation.missing.length) {
      console.warn(`[media] missing referenced files: ${reconciliation.missing.length}`)
    }
    for (const entry of reconciliation.orphanFailures) {
      console.warn(`[media] orphan не убран ${entry.filename}: ${entry.code}`)
    }
    if (reconciliation.symlinks.length) {
      console.warn(`[media] в каталоге найдены симлинки: ${reconciliation.symlinks.join(', ')}`)
    }

    audit(access.user, access.ipHash, 'media.gc', null, {
      removed: collected.removed,
      retained: collected.retained.length,
      ...reconciliation,
    })
    json(res, 200, {
      ok: true,
      removed: collected.removed,
      retained: collected.retained,
      reconciliation,
      usage: usageOf(db),
    })
  })

  return router
}
