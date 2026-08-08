// Правила управления учётками. Проверяются здесь, а не только через HTTP:
// теми же функциями пользуется scripts/admin-cli.mjs, где действующего
// пользователя нет вовсе (actorId = null) и защита «себя не трогай» не
// срабатывает. Именно в этом режиме и достижимо правило последнего владельца.

import { describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import {
  createUser,
  deleteUser,
  listUsers,
  resetPassword,
  resetTwoFactor,
  setRole,
  setStatus,
  UserAdminError,
} from './user-admin.js'

let sqliteAvailable = true
try {
  createSqliteDriver(':memory:').close()
} catch {
  sqliteAvailable = false
}
const describeDb = sqliteAvailable ? describe : describe.skip

const open = () => {
  const db = createSqliteDriver(':memory:')
  runMigrations(db)
  return db
}

const add = (db, username, role, status = 'active') =>
  Number(
    db.run(
      `INSERT INTO users (username, password_hash, role, status, must_change_password, totp_required)
       VALUES (?, 'test-only-hash', ?, ?, 0, 0)`,
      [username, role, status]
    ).lastInsertRowid
  )

const code = (run) => {
  try {
    run()
  } catch (error) {
    if (error instanceof UserAdminError) return error.code
    throw error
  }
  return null
}

describeDb('user-admin: последний владелец', () => {
  it('единственного владельца нельзя понизить', () => {
    const db = open()
    const owner = add(db, 'odin-vladelec', 'owner')
    add(db, 'redaktor', 'editor')

    expect(code(() => setRole(db, { userId: owner, role: 'admin' }))).toBe('last_owner')
    expect(db.get('SELECT role FROM users WHERE id = ?', [owner]).role).toBe('owner')
  })

  it('единственного владельца нельзя отключить', () => {
    const db = open()
    const owner = add(db, 'odin-vladelec', 'owner')
    expect(code(() => setStatus(db, { userId: owner, status: 'disabled' }))).toBe('last_owner')
  })

  it('единственного владельца нельзя удалить', () => {
    const db = open()
    const owner = add(db, 'odin-vladelec', 'owner')
    expect(code(() => deleteUser(db, { userId: owner }))).toBe('last_owner')
    expect(db.get('SELECT COUNT(*) AS n FROM users').n).toBe(1)
  })

  it('второго владельца понизить можно, а оставшегося — уже нет', () => {
    const db = open()
    const first = add(db, 'vladelec-raz', 'owner')
    const second = add(db, 'vladelec-dva', 'owner')

    expect(setRole(db, { userId: second, role: 'editor' }).changed).toBe(true)
    expect(code(() => setRole(db, { userId: first, role: 'editor' }))).toBe('last_owner')
  })

  it('отключённый владелец не удерживает права оставшихся', () => {
    const db = open()
    add(db, 'vladelec-v-otpuske', 'owner', 'disabled')
    const active = add(db, 'vladelec-na-meste', 'owner')

    // Владельцев в таблице двое, но войти может только один — значит понижать
    // его нельзя: отключённый управлять учётками не сможет.
    expect(code(() => setRole(db, { userId: active, role: 'admin' }))).toBe('last_owner')
  })

  it('повышение до владельца проверкой не ограничено', () => {
    const db = open()
    add(db, 'vladelec', 'owner')
    const helper = add(db, 'pomoshnik', 'viewer')
    expect(setRole(db, { userId: helper, role: 'owner' }).role).toBe('owner')
  })
})

describeDb('user-admin: свою учётку не трогают', () => {
  it.each([
    ['роль', (db, id) => setRole(db, { userId: id, role: 'viewer', actorId: id })],
    ['статус', (db, id) => setStatus(db, { userId: id, status: 'disabled', actorId: id })],
    ['второй фактор', (db, id) => resetTwoFactor(db, { userId: id, actorId: id })],
    ['удаление', (db, id) => deleteUser(db, { userId: id, actorId: id })],
  ])('%s', (_name, run) => {
    const db = open()
    const me = add(db, 'ya-sam', 'owner')
    add(db, 'zapasnoy', 'owner')
    expect(code(() => run(db, me))).toBe('self_target')
  })

  it('из консоли (без действующего пользователя) запрет не срабатывает', () => {
    const db = open()
    add(db, 'vladelec', 'owner')
    const other = add(db, 'drugoy', 'viewer')
    expect(setRole(db, { userId: other, role: 'editor' }).changed).toBe(true)
  })
})

describeDb('user-admin: список и состояния', () => {
  it('показывает второй фактор словом, а не набором флагов', () => {
    const db = open()
    const required = add(db, 'bez-2fa', 'editor')
    // add() заводит учётку без требования второго фактора; здесь нужен
    // противоположный случай — требуют, но ещё не подключили.
    db.run('UPDATE users SET totp_required = 1 WHERE id = ?', [required])
    const pending = add(db, 'v-processe', 'editor')
    const done = add(db, 'podklyuchil', 'editor')

    const secret = (userId, confirmedAt) =>
      db.run(
        `INSERT INTO totp_secrets (user_id, secret_ct, secret_iv, secret_tag, confirmed_at)
         VALUES (?, x'00', x'000000000000000000000000', x'00000000000000000000000000000000', ?)`,
        [userId, confirmedAt]
      )
    secret(pending, null)
    secret(done, Date.now())

    const byId = Object.fromEntries(listUsers(db).map((user) => [user.id, user]))
    expect(byId[required].twoFactor).toBe('required')
    expect(byId[pending].twoFactor).toBe('pending')
    expect(byId[done].twoFactor).toBe('on')
  })

  it('не отдаёт ни хеша пароля, ни секретов', () => {
    const db = open()
    add(db, 'kto-to', 'viewer')
    expect(JSON.stringify(listUsers(db))).not.toContain('test-only-hash')
  })
})

describeDb('user-admin: создание и сброс', () => {
  it('выдаёт временный пароль, который проходит проверку стойкости', async () => {
    const db = open()
    const { user, password } = await createUser(db, { username: 'novyy', role: 'editor' })

    expect(user.mustChangePassword).toBe(true)
    expect(password).toHaveLength(24)
    const stored = db.get('SELECT password_hash FROM users WHERE id = ?', [user.id]).password_hash
    expect(stored).not.toBe(password)
    expect(stored.startsWith('scrypt$')).toBe(true)
  })

  it('сброс пароля выдаёт другой пароль и требует его сменить', async () => {
    const db = open()
    const { user, password } = await createUser(db, { username: 'novyy', role: 'editor' })
    const reset = await resetPassword(db, { userId: user.id })

    expect(reset.password).not.toBe(password)
    expect(db.get('SELECT must_change_password AS m FROM users WHERE id = ?', [user.id]).m).toBe(1)
  })

  it.each([
    ['ab', 'invalid_username'],
    ['', 'invalid_username'],
    ['a'.repeat(33), 'invalid_username'],
  ])('логин "%s" отвергается', async (username, expected) => {
    const db = open()
    await expect(createUser(db, { username, role: 'viewer' })).rejects.toMatchObject({ code: expected })
  })
})
