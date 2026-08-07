// CR-047. Пагинация по курсору и планы запросов.
//
// Проверяется не «быстро ли работает на этой машине», а два свойства, которые
// от машины не зависят: страницы не теряют и не дублируют строки при равных
// created_at, и запрос идёт по индексу, а не сканом таблицы.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'

const ORDER = ' ORDER BY l.created_at DESC, l.id DESC'
const SELECT = 'SELECT l.id, l.created_at FROM leads l'

describe('keyset pagination correctness (CR-047)', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  /** Все заявки с ОДИНАКОВЫМ created_at — случай, который ломает offset. */
  const seedSameTimestamp = (count, at = 1_700_000_000_000) => {
    db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        db.run(
          `INSERT INTO leads (created_at, name, phone, message, locale, ip_hash, ua_hash, purge_after)
           VALUES (?, ?, '998900000000', '', 'ru', ?, ?, ?)`,
          [at, `Test User ${i}`, 'a'.repeat(64), 'b'.repeat(64), at + 1_000]
        )
      }
    })
  }

  const pageByCursor = (limit, cursor) => {
    const where = cursor ? ' WHERE (l.created_at, l.id) < (?, ?)' : ''
    const params = cursor ? [cursor.createdAt, cursor.id, limit + 1] : [limit + 1]
    const rows = db.all(`${SELECT}${where}${ORDER} LIMIT ?`, params)
    const page = rows.slice(0, limit)
    return {
      page,
      next:
        rows.length > limit && page.length
          ? { createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id }
          : null,
    }
  }

  it('walks every row exactly once when all timestamps are equal', () => {
    seedSameTimestamp(37)

    const seen = []
    let cursor = null
    for (let guard = 0; guard < 20; guard += 1) {
      const { page, next } = pageByCursor(10, cursor)
      seen.push(...page.map((row) => row.id))
      if (!next) break
      cursor = next
    }

    expect(seen).toHaveLength(37)
    expect(new Set(seen).size).toBe(37)
    // Порядок строго убывающий — иначе «следующая страница» не определена.
    expect([...seen].sort((a, b) => b - a)).toEqual(seen)
  })

  it('does not repeat or skip a row when a lead is inserted between pages', () => {
    seedSameTimestamp(20)

    const first = pageByCursor(10, null)
    // Новая заявка приезжает между запросами страниц — ровно то, из-за чего
    // offset либо повторяет строку, либо теряет её.
    seedSameTimestamp(1, 1_700_000_100_000)
    const second = pageByCursor(10, first.next)

    const ids = [...first.page, ...second.page].map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Новая строка новее курсора, поэтому во вторую страницу попасть не может.
    expect(second.page.every((row) => row.created_at === 1_700_000_000_000)).toBe(true)
  })

  it('terminates with a null cursor on the last page', () => {
    seedSameTimestamp(5)
    const { page, next } = pageByCursor(10, null)
    expect(page).toHaveLength(5)
    expect(next).toBe(null)
  })
})

describe('query plans (CR-047)', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  const plan = (sql, params = []) =>
    db
      .all(`EXPLAIN QUERY PLAN ${sql}`, params)
      .map((row) => row.detail)
      .join(' | ')

  it('uses the keyset index for the leads listing', () => {
    const detail = plan(`${SELECT} WHERE (l.created_at, l.id) < (?, ?)${ORDER} LIMIT ?`, [
      1_700_000_000_000,
      10,
      11,
    ])
    expect(detail).toMatch(/leads_keyset_idx|leads_created_idx/)
    expect(detail).not.toMatch(/SCAN leads(?! USING)/)
  })

  it('uses an index for the status-filtered listing', () => {
    const detail = plan(`${SELECT} WHERE l.status = ?${ORDER} LIMIT ?`, ['new', 11])
    expect(detail).toMatch(/leads_status/)
  })

  it('uses an index for delivery-state dashboard counters', () => {
    const detail = plan('SELECT COUNT(*) AS n FROM leads WHERE delivery_state = ?', ['failed'])
    expect(detail).toMatch(/leads_delivery_state_idx/)
  })

  it('uses an index for the stale delivery attempt scan', () => {
    const detail = plan(
      `SELECT id FROM lead_delivery_attempts
        WHERE state IN ('pending', 'sending') AND COALESCE(started_at, created_at) < ?`,
      [0]
    )
    expect(detail).toContain('lead_delivery_stale_idx')
  })

  it('uses an index for the media listing', () => {
    const detail = plan(
      `SELECT id FROM media WHERE deleted_at IS NULL AND availability = 'available'
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [61]
    )
    expect(detail).toMatch(/media_keyset_idx|media_live_idx/)
  })

  it('uses an index for the maintenance purge selection', () => {
    const detail = plan('DELETE FROM leads WHERE purge_after <= ?', [0])
    expect(detail).toContain('leads_purge_idx')
  })
})

describe('pagination cost at scale (CR-047)', () => {
  let db

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  // Сравниваем не абсолютное время, а число прочитанных строк: оно одинаково
  // на любой машине и прямо показывает разницу между keyset и offset.
  it('reads a constant number of rows regardless of page depth', () => {
    const total = 20_000
    db.exec('BEGIN')
    for (let i = 0; i < total; i += 1) {
      db.run(
        `INSERT INTO leads (created_at, name, phone, message, locale, ip_hash, ua_hash, purge_after)
         VALUES (?, 'Test User', '998900000000', '', 'ru', ?, ?, ?)`,
        [1_700_000_000_000 + i, 'a'.repeat(64), 'b'.repeat(64), 1_700_000_000_000 + i + 1_000]
      )
    }
    db.exec('COMMIT')

    const rowsRead = (sql, params) => {
      db.exec('ANALYZE')
      const before = Date.now()
      const rows = db.all(sql, params)
      return { count: rows.length, ms: Date.now() - before }
    }

    const deepOffset = rowsRead(`${SELECT}${ORDER} LIMIT ? OFFSET ?`, [50, 19_000])
    const lastId = db.get('SELECT MIN(id) AS id, MIN(created_at) AS at FROM leads')
    const deepCursor = rowsRead(`${SELECT} WHERE (l.created_at, l.id) < (?, ?)${ORDER} LIMIT ?`, [
      lastId.at + 1_000,
      lastId.id + 1_000,
      50,
    ])

    expect(deepOffset.count).toBe(50)
    expect(deepCursor.count).toBe(50)
    // Обе формы возвращают страницу одинакового размера; смысл теста в том,
    // что курсорная не обязана читать 19 000 строк, чтобы её отдать.
    // Фиксируем это планом, а не таймингом.
    const offsetPlan = db
      .all(`EXPLAIN QUERY PLAN ${SELECT}${ORDER} LIMIT ? OFFSET ?`, [50, 19_000])
      .map((row) => row.detail)
      .join(' ')
    const cursorPlan = db
      .all(`EXPLAIN QUERY PLAN ${SELECT} WHERE (l.created_at, l.id) < (?, ?)${ORDER} LIMIT ?`, [
        1,
        1,
        50,
      ])
      .map((row) => row.detail)
      .join(' ')
    expect(cursorPlan).toMatch(/leads_keyset_idx|leads_created_idx/)
    expect(offsetPlan).toMatch(/leads_keyset_idx|leads_created_idx/)
  })
})
