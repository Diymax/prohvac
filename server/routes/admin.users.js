// Раздел «Пользователи»: единственный способ завести коллегу и отобрать
// доступ, не заходя на сервер.
//
// До этого маршрута учётками управлял только scripts/admin-cli.mjs, то есть
// отзыв доступа у уволенного требовал SSH к хостингу. Правила при этом живут
// не здесь, а в server/application/user-admin.js — здесь только HTTP: разбор,
// права, журнал.
//
// ПОЧЕМУ ПАРОЛЬ ОТДАЁТСЯ В ОТВЕТЕ. Временный пароль нужно передать человеку,
// и других каналов у панели нет: почты сервер не отправляет. Он показывается
// один раз, в базе лежит только хеш, и первый же вход требует его сменить.
// В журнал он не попадает — см. audit() ниже.

import { verifyCsrf } from '../auth/csrf.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { readJson } from '../http/body.js'
import { json } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'
import {
  createUser,
  deleteUser,
  listUsers,
  resetPassword,
  resetTwoFactor,
  setRole,
  setStatus,
  UserAdminError,
} from '../application/user-admin.js'

// Тело здесь — это логин, роль и статус. Килобайта хватает с запасом, а всё,
// что больше, разбирать незачем.
const BODY_LIMIT = 1024

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)
`

/**
 * Запись в журнал. Пароли и секреты сюда не попадают никогда: журнал читают
 * из админки и выгружают в бэкап. Фиксируем, кто, что и над кем сделал.
 */
const audit = (db, entry) => {
  try {
    db.run(SQL_AUDIT, [
      entry.at ?? Date.now(),
      entry.userId ?? null,
      entry.actor,
      entry.action,
      entry.entityId == null ? null : String(entry.entityId),
      entry.ipHash ?? null,
      entry.diff == null ? null : JSON.stringify(entry.diff),
      entry.result ?? 'ok',
    ])
  } catch (error) {
    // Журнал не должен отменять уже выполненное действие.
    console.error(`[users] аудит не записан (${entry.action}): ${error.message}`)
  }
}

/**
 * Права и CSRF. Возвращает null, если ответ уже отправлен.
 *
 * Отказ по правам отвечает 403, а не 404: сюда доходит только тот, кто уже
 * прошёл guard, то есть сотрудник с живой сессией. Скрывать от него сам факт
 * существования раздела бессмысленно — он видит меню, — а вот понятная
 * причина отказа экономит обращение к владельцу.
 */
const authorize = async (db, req, res, { mutation = false, contentTypes } = {}) => {
  const requestContext = ensureRequestContext(req)

  const access = requireActive(db, req)
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return null
  }

  if (mutation) {
    const csrf = verifyCsrf(req, access.session, {
      publicOrigin: config.publicOrigin,
      ...(contentTypes === undefined ? {} : { contentTypes }),
    })
    if (!csrf.ok) {
      json(res, csrf.error === 'unsupported_media_type' ? 415 : 403, {
        ok: false,
        error: csrf.error,
      })
      return null
    }
  }

  const { ipHash } = requestContext

  if (!hasCapability(access.user, CAPABILITY.USERS_MANAGE)) {
    audit(db, {
      userId: access.user.id,
      actor: access.user.username,
      action: 'users.denied',
      ipHash,
      diff: { role: access.user.role },
      result: 'denied',
    })
    json(res, 403, { ok: false, error: 'forbidden' })
    return null
  }

  return { user: access.user, ipHash }
}

const readBody = async (req, res) => {
  const body = await readJson(req, { limit: BODY_LIMIT })
  if (body.ok) return body.value

  json(res, body.error === 'payload_too_large' ? 413 : 400, { ok: false, error: body.error })
  return null
}

/** '42' → 42. Всё остальное — 404, а не 400: такого пользователя нет. */
const readId = (params, res) => {
  const raw = String(params?.id ?? '')
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) {
    json(res, 404, { ok: false, error: 'not_found' })
    return null
  }
  return Number(raw)
}

// Коды из UserAdminError — это отказы по правилам, а не сбои. 409 говорит
// «состояние не позволяет», 404 — «такого нет», 400 — «данные не годятся».
const STATUS_BY_CODE = Object.freeze({
  not_found: 404,
  self_target: 409,
  last_owner: 409,
  username_taken: 409,
  invalid_username: 400,
  unknown_role: 400,
  unknown_status: 400,
})

/**
 * Выполняет операцию домена и превращает её отказ в ответ.
 * Всё, что не UserAdminError, — настоящий сбой, и его пробрасываем наверх:
 * обработчик ошибок сервера ответит 500 и запишет стек.
 */
const guarded = async (db, res, context, action, run) => {
  try {
    const result = await run()
    return result
  } catch (error) {
    if (!(error instanceof UserAdminError)) throw error
    audit(db, {
      userId: context.user.id,
      actor: context.user.username,
      action,
      ipHash: context.ipHash,
      diff: { error: error.code },
      result: 'denied',
    })
    json(res, STATUS_BY_CODE[error.code] ?? 400, { ok: false, error: error.code })
    return null
  }
}

export const registerAdminUsersRoutes = (router, deps = {}) => {
  const { db } = deps
  if (!db) throw new TypeError('admin.users: нужен deps.db')

  router.register('GET', '/api/admin/users', async (req, res) => {
    const context = await authorize(db, req, res)
    if (!context) return undefined
    return json(res, 200, { ok: true, users: listUsers(db), self: context.user.id })
  })

  router.register('POST', '/api/admin/users', async (req, res) => {
    const context = await authorize(db, req, res, { mutation: true })
    if (!context) return undefined

    const body = await readBody(req, res)
    if (!body) return undefined

    // Пароль генерирует сервер, а не оператор: придуманный человеком временный
    // пароль обычно один и тот же на всех, кого он завёл.
    const created = await guarded(db, res, context, 'users.create', () =>
      createUser(db, { username: body.username, role: body.role })
    )
    if (!created) return undefined

    audit(db, {
      userId: context.user.id,
      actor: context.user.username,
      action: 'users.create',
      entityId: created.user.id,
      ipHash: context.ipHash,
      diff: { username: created.user.username, role: created.user.role },
    })
    return json(res, 201, { ok: true, user: created.user, password: created.password })
  })

  router.register('PATCH', '/api/admin/users/:id', async (req, res, params) => {
    const context = await authorize(db, req, res, { mutation: true })
    if (!context) return undefined

    const id = readId(params, res)
    if (!id) return undefined

    const body = await readBody(req, res)
    if (!body) return undefined

    const wantsRole = typeof body.role === 'string'
    const wantsStatus = typeof body.status === 'string'
    // Ровно одно поле за запрос: «понизить и отключить» — два разных решения,
    // и в журнале они должны стоять двумя строками.
    if (wantsRole === wantsStatus) {
      return json(res, 400, { ok: false, error: 'role_or_status' })
    }

    const action = wantsRole ? 'users.role' : 'users.status'
    const result = await guarded(db, res, context, action, () =>
      wantsRole
        ? setRole(db, { userId: id, role: body.role, actorId: context.user.id })
        : setStatus(db, { userId: id, status: body.status, actorId: context.user.id })
    )
    if (!result) return undefined

    audit(db, {
      userId: context.user.id,
      actor: context.user.username,
      action,
      entityId: id,
      ipHash: context.ipHash,
      diff: wantsRole ? { role: result.role } : { status: result.status, revoked: result.revoked },
    })
    return json(res, 200, { ok: true, users: listUsers(db) })
  })

  router.register('POST', '/api/admin/users/:id/reset-password', async (req, res, params) => {
    const context = await authorize(db, req, res, { mutation: true })
    if (!context) return undefined

    const id = readId(params, res)
    if (!id) return undefined

    const result = await guarded(db, res, context, 'users.reset_password', () =>
      resetPassword(db, { userId: id, actorId: context.user.id })
    )
    if (!result) return undefined

    audit(db, {
      userId: context.user.id,
      actor: context.user.username,
      action: 'users.reset_password',
      entityId: id,
      ipHash: context.ipHash,
      diff: { revoked: result.revoked },
    })
    return json(res, 200, {
      ok: true,
      password: result.password,
      revoked: result.revoked,
      users: listUsers(db),
    })
  })

  router.register('POST', '/api/admin/users/:id/reset-2fa', async (req, res, params) => {
    const context = await authorize(db, req, res, { mutation: true })
    if (!context) return undefined

    const id = readId(params, res)
    if (!id) return undefined

    const result = await guarded(db, res, context, 'users.reset_2fa', () =>
      resetTwoFactor(db, { userId: id, actorId: context.user.id })
    )
    if (!result) return undefined

    audit(db, {
      userId: context.user.id,
      actor: context.user.username,
      action: 'users.reset_2fa',
      entityId: id,
      ipHash: context.ipHash,
      diff: { secrets: result.secrets, codes: result.codes, revoked: result.revoked },
    })
    return json(res, 200, { ok: true, ...result, users: listUsers(db) })
  })

  // contentTypes: null снимает третий барьер CSRF — проверку типа тела.
  // Здесь он неприменим: тела у запроса нет, а простая HTML-форма умеет только
  // GET и POST и метод DELETE не отправит вовсе. Проверка Origin и токена
  // сессии остаются на месте, и именно они здесь и защищают.
  router.register('DELETE', '/api/admin/users/:id', async (req, res, params) => {
    const context = await authorize(db, req, res, { mutation: true, contentTypes: null })
    if (!context) return undefined

    const id = readId(params, res)
    if (!id) return undefined

    const result = await guarded(db, res, context, 'users.delete', () =>
      deleteUser(db, { userId: id, actorId: context.user.id })
    )
    if (!result) return undefined

    audit(db, {
      userId: context.user.id,
      actor: context.user.username,
      action: 'users.delete',
      entityId: id,
      ipHash: context.ipHash,
      diff: { username: result.username, role: result.role },
    })
    return json(res, 200, { ok: true, users: listUsers(db) })
  })
}
