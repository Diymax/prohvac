// Управление учётными записями: список, роли, отключение, сброс пароля и 2FA.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ КОД В МАРШРУТЕ. Ровно те же операции выполняет
// scripts/admin-cli.mjs, и до этого файла они существовали только там. Две
// реализации одних правил разошлись бы на первом же изменении: например,
// «сброс 2FA удаляет и незавершённое подключение» (CR-063) знал бы CLI, а
// админка — нет, и оператор получил бы разный результат от одного действия.
//
// ЧТО ЗДЕСЬ ЗАПРЕЩЕНО И ПОЧЕМУ. Все проверки ниже защищают ровно от двух
// способов потерять доступ к панели навсегда:
//
//   1. Себя этим модулем не трогают. Понизить себе роль, отключить или удалить
//      свою учётку — три способа выйти из панели без возможности вернуться,
//      причём в один клик и без подтверждения на стороне сервера. Сменить себе
//      пароль и второй фактор можно в разделе «Безопасность», где это делается
//      с вводом текущего пароля.
//   2. Последнего владельца нельзя ни понизить, ни отключить, ни удалить.
//      Право управлять учётками есть только у роли owner (см.
//      server/policies/capabilities.js), поэтому исчезновение последнего
//      владельца означает, что новых пользователей не заведёт уже никто —
//      останется только правка базы руками.
//
// Отключённый владелец в счёт не идёт: войти он не может, значит и управлять
// учётками не может тоже.

import { generatePassword, hashPassword, validatePasswordStrength } from '../auth/password.js'
import { revokeAllForUser } from '../auth/session.js'
import { ROLES } from '../auth/guard.js'

export const USER_STATUSES = Object.freeze(['active', 'disabled'])

/** Ошибка с машиночитаемым кодом: маршрут отдаёт его как есть, UI переводит. */
export class UserAdminError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'UserAdminError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new UserAdminError(code, message)
}

// Те же границы, что в CHECK таблицы users: длина 3..32. Набор символов уже
// наш — база принимает любой текст, а логин попадает в журналы и в заголовки
// писем, поэтому управляющие символы и пробелы в нём не нужны.
const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/

export const normalizeUsername = (value) => String(value ?? '').trim()

const SQL_LIST = `
  SELECT u.id, u.username, u.role, u.status, u.must_change_password,
         u.totp_required, u.failed_attempts, u.locked_until, u.last_login_at,
         u.created_at,
         t.user_id IS NOT NULL AS has_totp,
         t.confirmed_at AS totp_confirmed_at,
         (SELECT COUNT(*) FROM recovery_codes r
           WHERE r.user_id = u.id AND r.used_at IS NULL) AS recovery_left,
         -- Живая сессия — не отозванная и не просроченная ни по одному
         -- из двух сроков: подвижному и жёсткому потолку.
         (SELECT COUNT(*) FROM sessions s
           WHERE s.user_id = u.id
             AND s.revoked_at IS NULL
             AND s.idle_expires_at > :now
             AND s.absolute_expires_at > :now) AS sessions_open
    FROM users u
    LEFT JOIN totp_secrets t ON t.user_id = u.id
   ORDER BY u.id
`

const SQL_INSERT = `
  INSERT INTO users (
    username, password_hash, password_changed_at, must_change_password,
    role, status, totp_required, created_at, updated_at
  ) VALUES (?, ?, ?, 1, ?, 'active', 1, ?, ?)
  RETURNING id
`

const SQL_BY_ID = 'SELECT id, username, role, status FROM users WHERE id = ?'
const SQL_ACTIVE_OWNERS = "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'"

/**
 * Второй фактор одним словом — то же значение, что печатает CLI.
 * Считается на сервере: «есть секрет, но он не подтверждён» — состояние,
 * которое иначе каждый экран выводил бы по-своему.
 */
const twoFactorState = (row) => {
  if (!row.has_totp) return row.totp_required ? 'required' : 'off'
  if (row.totp_confirmed_at == null) return 'pending'
  return 'on'
}

const present = (row) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  status: row.status,
  mustChangePassword: row.must_change_password === 1,
  twoFactor: twoFactorState(row),
  recoveryLeft: row.recovery_left,
  sessionsOpen: row.sessions_open,
  failedAttempts: row.failed_attempts,
  lockedUntil: row.locked_until,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
})

/** Список для экрана «Пользователи». Ни хешей, ни секретов в выборке нет. */
export const listUsers = (db, { now = Date.now() } = {}) => db.all(SQL_LIST, { now }).map(present)

const requireUser = (db, userId) => {
  const user = db.get(SQL_BY_ID, [userId])
  if (!user) fail('not_found', `пользователь #${userId} не найден`)
  return user
}

const activeOwners = (db) => db.get(SQL_ACTIVE_OWNERS).n

/**
 * Пароль, который можно записать: либо переданный (проверяем той же мерой,
 * что и форму смены пароля), либо сгенерированный.
 */
const usable = (password, username) => {
  if (password == null) return generatePassword(username)
  const strength = validatePasswordStrength(password, username)
  if (!strength.ok) fail(strength.error, 'пароль не проходит проверку стойкости')
  return password
}

/**
 * Общая преамбула изменяющих операций: находим цель и отсекаем себя.
 *
 * actorId сравнивается всегда, даже когда вызов пришёл из CLI и актора нет:
 * там actorId равен null и совпасть не может, а отдельная ветка «из консоли
 * можно всё» однажды оказалась бы и в HTTP-обработчике.
 */
const target = (db, userId, actorId) => {
  const user = requireUser(db, userId)
  if (actorId != null && user.id === actorId) {
    fail('self_target', 'свою учётную запись этим разделом не меняют')
  }
  return user
}

/** Останется ли хоть один владелец, если этот перестанет им быть. */
const assertNotLastOwner = (db, user) => {
  if (user.role !== 'owner' || user.status !== 'active') return
  if (activeOwners(db) <= 1) {
    fail('last_owner', 'это последний действующий владелец — панель осталась бы без управления')
  }
}

/**
 * Заводит учётку и возвращает её вместе с временным паролем.
 *
 * Пароль генерируется здесь, а не в вызывающем коде: проверка стойкости
 * сверяется с логином (пароль не должен его содержать), и знает логин именно
 * этот слой. Вернувшийся пароль показывают ровно один раз — в базе только хеш.
 *
 * Готовый пароль принимается только от консоли (admin-cli умеет читать его
 * со stdin) и проходит ту же проверку стойкости, что и пароль, придуманный
 * человеком в форме смены.
 */
export const createUser = async (db, { username, role, password, now = Date.now() }) => {
  const name = normalizeUsername(username)
  if (!USERNAME.test(name)) {
    fail('invalid_username', 'логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание')
  }
  if (!ROLES.includes(role)) fail('unknown_role', `роль "${role}" неизвестна`)
  // COLLATE NOCASE в схеме делает 'Admin' и 'admin' одной учёткой; проверяем
  // заранее, чтобы отдать понятный код вместо ошибки уникального индекса.
  if (db.get('SELECT id FROM users WHERE username = ?', [name])) {
    fail('username_taken', `логин "${name}" занят`)
  }

  const secret = usable(password, name)
  const hash = await hashPassword(secret)
  const { id } = db.get(SQL_INSERT, [name, hash, now, role, now, now])
  // must_change_password и totp_required проставлены жёстко: временный пароль
  // прошёл через того, кто заводил учётку, а вход без второго фактора держится
  // на одном этом пароле.
  return { user: present(db.all(SQL_LIST, { now }).find((row) => row.id === id)), password: secret }
}

export const setRole = (db, { userId, role, actorId = null, now = Date.now() }) => {
  if (!ROLES.includes(role)) fail('unknown_role', `роль "${role}" неизвестна`)
  const user = target(db, userId, actorId)
  if (user.role === role) return { changed: false, role }
  if (role !== 'owner') assertNotLastOwner(db, user)

  db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, now, user.id])
  // Сессии не отзываются: guard читает роль из базы на каждом запросе
  // (server/auth/guard.js), поэтому понижение действует со следующего клика,
  // а выкидывать человека из панели посреди работы незачем.
  return { changed: true, role, username: user.username }
}

export const setStatus = (db, { userId, status, actorId = null, now = Date.now() }) => {
  if (!USER_STATUSES.includes(status)) fail('unknown_status', `статус "${status}" неизвестен`)
  const user = target(db, userId, actorId)
  if (user.status === status) return { changed: false, status, revoked: 0 }
  if (status === 'disabled') assertNotLastOwner(db, user)

  const revoked = db.transaction(() => {
    db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, now, user.id])
    // Отключение действует и без этого — accountStateOf возвращает 'disabled'
    // по свежей строке пользователя. Сессии всё равно закрываем: отключают,
    // как правило, потому что доступ нужно отобрать, и оставлять живые строки
    // в sessions значит оставлять вопрос «а точно отобрали?».
    return status === 'disabled' ? revokeAllForUser(db, user.id, { reason: 'admin', now }) : 0
  })

  return { changed: true, status, revoked, username: user.username }
}

/** Выдаёт новый временный пароль и закрывает все сессии владельца учётки. */
export const resetPassword = async (db, { userId, password, actorId = null, now = Date.now() }) => {
  const user = target(db, userId, actorId)
  const secret = usable(password, user.username)
  const hash = await hashPassword(secret)

  const revoked = db.transaction(() => {
    db.run(
      `UPDATE users
          SET password_hash = ?, password_changed_at = ?, must_change_password = 1,
              failed_attempts = 0, locked_until = NULL, lock_level = 0, updated_at = ?
        WHERE id = ?`,
      [hash, now, now, user.id]
    )
    // Старый пароль мог утечь — ради этого пароль и сбрасывают. Сессии,
    // выданные по нему, обязаны умереть вместе с ним.
    return revokeAllForUser(db, user.id, { reason: 'password_change', now })
  })

  return { revoked, password: secret, username: user.username }
}

export const resetTwoFactor = (db, { userId, actorId = null, now = Date.now() }) => {
  const user = target(db, userId, actorId)

  const result = db.transaction(() => {
    // Секрет удаляем, а не выдаём новый: подтвердить его всё равно нужно кодом
    // из приложения, то есть при живом человеке за экраном.
    const secrets = db.run('DELETE FROM totp_secrets WHERE user_id = ?', [user.id]).changes
    // Коды восстановления выпускались вместе со старым секретом и после его
    // удаления открывают вход в обход второго фактора, которого больше нет.
    const codes = db.run('DELETE FROM recovery_codes WHERE user_id = ?', [user.id]).changes
    // CR-063. Незавершённое подключение — такой же секрет, как подтверждённый:
    // он ждёт лишь кода из приложения.
    const pending = db.run('DELETE FROM totp_pending WHERE user_id = ?', [user.id]).changes
    db.run('UPDATE users SET totp_required = 1, updated_at = ? WHERE id = ?', [now, user.id])
    // Живая сессия пережила бы сброс и осталась бы подтверждённой вторым
    // фактором, которого уже нет.
    const revoked = revokeAllForUser(db, user.id, { reason: 'admin', now })
    return { secrets, codes, pending, revoked }
  })

  return { ...result, username: user.username }
}

export const deleteUser = (db, { userId, actorId = null }) => {
  const user = target(db, userId, actorId)
  assertNotLastOwner(db, user)

  // Внешние ключи разведены схемой заранее: totp_secrets, recovery_codes,
  // сессии и незавершённые подключения уходят каскадом, а следы в журнале,
  // медиатеке и заявках (uploaded_by, updated_by, handled_by, actor_user_id)
  // объявлены ON DELETE SET NULL. История переживает удаление автора —
  // иначе удаление учётки стирало бы и то, что она делала.
  db.run('DELETE FROM users WHERE id = ?', [user.id])
  return { username: user.username, role: user.role }
}
