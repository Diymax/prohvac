// Проверка доступа к /api/admin/*: есть ли живая сессия, кто её владелец,
// хватает ли ему прав.
//
// ГЛАВНОЕ В ЭТОМ ФАЙЛЕ — ФОРМА ОТКАЗА, А НЕ САМИ ПРОВЕРКИ.
//
// Вся защита админки держится на том, что её адрес (ADMIN_SECRET_PATH) не
// угадывается, а её API ничем не выделяется на фоне остального сайта. Стоит
// ответить на /api/admin/session без куки честным 401 или 403 — и путь
// перестаёт быть секретом: сканеру больше не нужно перебирать 24 символа,
// достаточно постучаться в /api/admin/* и посмотреть, отличается ли ответ
// от ответа на заведомо несуществующий адрес. Один отличающийся байт
// превращает всю схему в оракул «здесь есть админка».
//
// Поэтому guard НИЧЕГО НЕ ОТВЕЧАЕТ САМ, кроме denyAsNotFound(). Для анонимного
// и недействительной сессии тот отдаёт ровно то же, что неизвестный URL.
// Единственное исключение — уже аутентифицированная учётка с временным
// паролем: ей нужна машинно-читаемая причина, чтобы открыть форму смены, но
// административные данные до смены она всё равно не получает.
//
//   const access = requireActive(db, req)
//   if (!access.ok) return denyAsNotFound(req, res)
//
// Единственное исключение из правила — POST /api/admin/session (форма входа):
// он обязан отвечать анонимному клиенту по определению, и там 401 законен.
//
// Причина отказа возвращается в поле error, но наружу она не уходит НИКОГДА:
// она нужна журналу и тестам. Клиенту разница между «куки нет», «сессия
// протухла» и «пользователь заблокирован» не сообщается.

import { apiNotFound, json, uniform404 } from '../http/respond.js'
import { ACCOUNT_STATE, accountStateOf } from '../policies/account-state.js'
import { loadSession, readSessionToken, touchSession } from './session.js'

// Тот же список, что в CHECK таблицы users. Дублируется намеренно: опечатка
// в имени роли должна падать здесь понятной ошибкой, а не молча создавать
// правило, под которое никто не подходит.
export const ROLES = Object.freeze(['owner', 'admin', 'editor', 'viewer'])

// password_hash в выборке нет сознательно: guard дёргается на каждом запросе
// админки, и хеш пароля не должен расползаться по объектам, которые потом
// кто-нибудь сериализует в лог или в ответ. Кому нужен хеш (смена пароля,
// повторное подтверждение) — читает его отдельным запросом.
const SQL_USER = `
  SELECT id, username, role, status, must_change_password,
         password_changed_at, totp_required, last_login_at
    FROM users
   WHERE id = ?
`

const deny = (error) => ({ ok: false, error, session: null, user: null, token: '' })

// Существующие route handlers вызывают requireActive(), а затем общий
// denyAsNotFound(req,res). Передавать access вторым аргументом пришлось бы
// править каждый маршрут и оставило бы возможность забыть его в новом.
// WeakMap связывает доказанный guard'ом отказ с тем же объектом запроса,
// не мутирует IncomingMessage и не удерживает завершённые запросы в памяти.
const pendingPasswordDenials = new WeakMap()

const markPendingPasswordDenial = (req) => {
  if (req && (typeof req === 'object' || typeof req === 'function')) {
    pendingPasswordDenials.set(req, true)
  }
}

const consumePendingPasswordDenial = (req) => {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) return false
  const pending = pendingPasswordDenials.get(req) === true
  pendingPasswordDenials.delete(req)
  return pending
}

/**
 * Живая сессия и её владелец.
 *
 * Порядок проверок: кука -> строка сессии (loadSession сам смотрит revoked_at
 * и оба срока) -> требуемое состояние -> пользователь -> продление.
 *
 * options.state — требуемое значение sessions.state. Передавать обязательно
 * там, где важно различие: сессия pending_totp пароль уже подтвердила, но
 * второго фактора не прошла, и пускать её куда-либо, кроме /session/totp
 * и /session/recovery, нельзя.
 *
 * @param {object} db соединение из server/db/index.js
 * @param {import('node:http').IncomingMessage} req
 * @param {{now?: number, state?: string|null}} [options]
 * @returns {{ok: true, session: object, user: object, token: string,
 *            accountState: string, error: null}
 *          |{ok: false, error: string, session: null, user: null, token: string}}
 */
export const requireSession = (db, req, options = {}) => {
  const { now = Date.now(), state = null } = options

  const token = readSessionToken(req)
  const loaded = loadSession(db, token, { now })
  if (!loaded.ok) return deny(loaded.error)

  const { session } = loaded
  if (state !== null && session.state !== state) return deny('wrong_state')

  const user = db.get(SQL_USER, [session.user_id])
  // Пользователя нет — строку сессии должен был унести ON DELETE CASCADE.
  // Раз она здесь, база в рассогласованном состоянии, и доступ по такой
  // сессии выдавать точно не надо.
  if (!user) return deny('user_missing')
  if (user.status !== 'active') return deny('user_disabled')

  // Продлеваем только полноценные сессии. У pending_totp окно бездействия —
  // это и есть её пятиминутный срок жизни (см. PENDING_TTL_MS в
  // server/routes/admin.auth.js), и сдвигать его каждым запросом значит
  // разрешить держать недоподтверждённую сессию открытой сколько угодно.
  if (session.state === 'active') touchSession(db, session, { now })

  return {
    ok: true,
    error: null,
    session,
    user,
    token,
    accountState: accountStateOf({ user, session }),
  }
}

/**
 * Сессия, прошедшая все факторы И не ожидающая обязательной смены пароля.
 *
 * allowPasswordChangePending разрешён только минимальным маршрутам
 * GET /session и POST /password. Logout использует requireSession(), потому
 * что завершать разрешено также брошенную pending_totp-сессию.
 */
export const requireActive = (db, req, options = {}) => {
  const { allowPasswordChangePending = false, ...sessionOptions } = options
  const access = requireSession(db, req, { ...sessionOptions, state: 'active' })
  if (!access.ok) return access

  if (access.accountState === ACCOUNT_STATE.pendingPasswordChange) {
    if (allowPasswordChangePending) return access
    markPendingPasswordDenial(req)
    return deny('must_change_password')
  }

  // При state='active' и живом пользователе это значение ожидается всегда.
  // Неизвестное сочетание полей закрываем, а не превращаем в active.
  if (access.accountState !== ACCOUNT_STATE.active) return deny('account_not_active')
  return access
}

/**
 * Фабрика проверки роли: requireRole(['owner', 'admin']) возвращает такую же
 * функцию (db, req, options), что и requireActive, но с дополнительным
 * условием по users.role.
 *
 * Список ролей проверяется здесь, на сборке маршрутов, а не при первом
 * запросе: опечатка вроде 'admins' иначе просто закрывала бы эндпоинт всем,
 * и заметили бы это уже в проде.
 */
export const requireRole = (roles) => {
  const list = Array.isArray(roles) ? roles : [roles]
  if (!list.length) throw new TypeError('guard: requireRole без ролей запрещает всё')

  for (const role of list) {
    if (!ROLES.includes(role)) {
      throw new TypeError(`guard: неизвестная роль ${JSON.stringify(role)}`)
    }
  }

  const allowed = new Set(list)

  return (db, req, options = {}) => {
    const access = requireActive(db, req, options)
    if (!access.ok) return access
    if (!allowed.has(access.user.role)) return deny('forbidden')
    return access
  }
}

/** Подходит ли роль пользователя под список. Для проверок внутри обработчика,
 *  где сессия уже загружена и второй раз ходить в базу незачем. */
export const hasRole = (user, roles) => {
  const list = Array.isArray(roles) ? roles : [roles]
  return typeof user?.role === 'string' && list.includes(user.role)
}

/**
 * Отказ, неотличимый от несуществующего адреса. Единственный допустимый ответ
 * на непройденный guard — см. комментарий в шапке файла.
 *
 * Форма ответа обязана совпадать с той, что даёт этот же сервер на заведомо
 * несуществующий путь ТОГО ЖЕ РОДА. Для страниц это оболочка сайта, а для
 * /api/* — JSON {ok:false,error:'not_found'} со статусом 404.
 *
 * Раньше здесь во всех случаях отдавалась оболочка, и это само по себе было
 * оракулом: /api/admin/leads возвращал 200 и HTML, а /api/чего-нибудь-нет —
 * 404 и JSON. Достаточно сравнить два ответа, чтобы понять, что админские
 * маршруты на сервере есть.
 */
export const denyAsNotFound = async (req, res) => {
  if (consumePendingPasswordDenial(req)) {
    json(res, 403, { ok: false, error: 'must_change_password' })
    return
  }

  const path = (req?.url || '').split('?')[0]
  if (path === '/api' || path.startsWith('/api/')) {
    apiNotFound(res)
    return
  }
  await uniform404(req, res)
}
