// CR-063. Сброс второго фактора обязан убирать и незавершённое подключение.
//
// totp_pending (CR-035) хранит секрет-кандидат, которому не хватает только
// кода из приложения. Сброс, оставляющий такую строку, отдаёт следующему входу
// секрет, выпущенный ДО потери телефона, — то самое, ради устранения чего
// сброс и делают. Строка исчезала сама по каскаду от сессии, то есть на чужом
// расписании и без какой-либо гарантии по времени.
//
// Команда проверяется запуском настоящего процесса: admin-cli.mjs выполняет
// main() прямо при импорте, поэтому импортировать его в тест нельзя, а
// проверять SQL текстом означало бы проверять текст, а не поведение.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Явный импорт вместо глобалей: этот файл лежит в scripts/ и линтуется
// с браузерным окружением (см. overrides в .eslintrc.cjs).
import { env, execPath } from 'node:process'

import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../server/db/driver.js'
import { runMigrations } from '../server/db/migrate.js'

let available = true
try {
  createSqliteDriver(':memory:').close()
} catch {
  available = false
}

const describeDb = available ? describe : describe.skip

const REPO_ROOT = join(import.meta.dirname, '..')
const CLI = join(REPO_ROOT, 'scripts', 'admin-cli.mjs')
const USERNAME = 'cli-2fa-test-user'
const SESSION_ID = 'c'.repeat(64)
const HASH = 'a'.repeat(64)
const blob = (size, fill) => new Uint8Array(size).fill(fill)

let dataDir = null

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
})

/** Учётка с подтверждённым вторым фактором И незавершённым подключением. */
const seed = () => {
  dataDir = mkdtempSync(join(tmpdir(), 'prohvac-cli-2fa-'))
  const db = createSqliteDriver(join(dataDir, 'app.sqlite'))
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)

  const now = Date.now()
  const user = db.run(
    `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
     VALUES (?, 'test-only-hash', 'owner', 0, 1)`,
    [USERNAME]
  )
  const userId = Number(user.lastInsertRowid)

  db.run(
    `INSERT INTO sessions (id, user_id, csrf_hash, ip_hash, ua_hash,
                           idle_expires_at, absolute_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [SESSION_ID, userId, HASH, HASH, HASH, now + 1_800_000, now + 28_800_000]
  )
  db.run(
    `INSERT INTO totp_secrets (user_id, secret_ct, secret_iv, secret_tag, confirmed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, blob(32, 1), blob(12, 2), blob(16, 3), now]
  )
  db.run(
    `INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)`,
    [userId, 'test-only-recovery-hash', now]
  )
  db.run(
    `INSERT INTO totp_pending (user_id, session_id, secret_ct, secret_iv, secret_tag,
                               created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, SESSION_ID, blob(32, 4), blob(12, 5), blob(16, 6), now, now + 600_000]
  )

  db.close()
  return { userId }
}

const runCli = (...args) =>
  spawnSync(execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...env, DATA_DIR: dataDir, NODE_ENV: 'development' },
  })

const inspect = () => {
  const db = createSqliteDriver(join(dataDir, 'app.sqlite'))
  const rows = {
    secrets: db.get('SELECT COUNT(*) AS n FROM totp_secrets').n,
    codes: db.get('SELECT COUNT(*) AS n FROM recovery_codes').n,
    pending: db.get('SELECT COUNT(*) AS n FROM totp_pending').n,
    liveSessions: db.get('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').n,
  }
  db.close()
  return rows
}

describeDb('admin-cli reset-2fa (CR-063)', () => {
  it('удаляет незавершённое подключение вместе с секретом и кодами', () => {
    seed()
    expect(inspect()).toMatchObject({ secrets: 1, codes: 1, pending: 1, liveSessions: 1 })

    const result = runCli('reset-2fa', '--username', USERNAME)

    expect(result.status).toBe(0)
    // Одна транзакция: секрет, коды, кандидат и сессии либо исчезают вместе,
    // либо не исчезает ничего.
    expect(inspect()).toMatchObject({ secrets: 0, codes: 0, pending: 0, liveSessions: 0 })
  })

  it('сообщает о снятом незавершённом подключении', () => {
    seed()

    const result = runCli('reset-2fa', '--username', USERNAME)

    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/незавершённых подключений 1/)
  })
})
