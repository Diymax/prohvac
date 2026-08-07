// CR-044. Раньше session.js держал собственный transact() с проверкой
// db.isTransaction — свойства с таким именем не существует ни у драйвера, ни
// у обёртки (там inTransaction), поэтому вложенный вызов всегда доходил до
// второго BEGIN IMMEDIATE и падал. Тесты фиксируют, что транзакции теперь
// принадлежат драйверу и вкладываются через SAVEPOINT.

import { describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { gcSessions } from './session.js'

const schema = `
  CREATE TABLE sessions (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    csrf_hash      TEXT NOT NULL,
    state          TEXT NOT NULL,
    amr            TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    revoked_at     INTEGER,
    revoked_reason TEXT
  );
`

const fixture = () => {
  const db = createSqliteDriver(':memory:')
  db.exec(schema)
  return db
}

describe('session transactions (CR-044)', () => {
  it('runs a top-level transaction', () => {
    const db = fixture()
    try {
      expect(gcSessions(db, 1_000)).toEqual({ expired: 0, deleted: 0 })
    } finally {
      db.close()
    }
  })

  it('nests inside a transaction opened by the caller', () => {
    const db = fixture()
    try {
      const result = db.transaction(() => gcSessions(db, 1_000))
      expect(result).toEqual({ expired: 0, deleted: 0 })
      expect(db.inTransaction).toBe(false)
    } finally {
      db.close()
    }
  })

  it('rolls the outer transaction back when the caller fails after a nested call', () => {
    const db = fixture()
    try {
      db.exec(
        `INSERT INTO sessions (
           user_id, token_hash, csrf_hash, state, created_at, last_seen_at,
           idle_expires_at, absolute_expires_at
         ) VALUES (1, 'a', 'b', 'active', 0, 0, 10, 10)`
      )

      expect(() =>
        db.transaction(() => {
          db.exec("UPDATE sessions SET state = 'mutated'")
          gcSessions(db, 1_000)
          throw new Error('caller failed')
        })
      ).toThrow('caller failed')

      // Ни собственная запись вызывающего кода, ни вложенный gcSessions
      // не должны пережить откат внешней транзакции.
      const row = db.get('SELECT state, revoked_at FROM sessions WHERE id = 1')
      expect(row.state).toBe('active')
      expect(row.revoked_at).toBe(null)
      expect(db.inTransaction).toBe(false)
    } finally {
      db.close()
    }
  })

  it('releases the savepoint when a nested call fails without killing the outer transaction', () => {
    const db = fixture()
    try {
      db.transaction(() => {
        db.exec(
          `INSERT INTO sessions (
             user_id, token_hash, csrf_hash, state, created_at, last_seen_at,
             idle_expires_at, absolute_expires_at
           ) VALUES (2, 'c', 'd', 'active', 0, 0, 10, 10)`
        )

        expect(() =>
          db.transaction(() => {
            db.exec("UPDATE sessions SET state = 'inner'")
            throw new Error('inner failed')
          })
        ).toThrow('inner failed')
      })

      // Запись внешней транзакции должна пережить откат вложенной точки.
      expect(db.get('SELECT state FROM sessions WHERE user_id = 2').state).toBe('active')
    } finally {
      db.close()
    }
  })

  it('refuses a raw handle that cannot nest transactions', () => {
    const raw = { exec: () => {}, prepare: () => ({ run: () => ({}) }) }
    expect(() => gcSessions(raw, 1_000)).toThrow(/driver\.transaction/)
  })
})
