import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createLeadRepository } from '../repositories/leads.js'
import {
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_LEASE_MS,
  MAINTENANCE_RETRY_MAX_MS,
  MAINTENANCE_RETRY_MS,
  MAINTENANCE_TIME_BUDGET_MS,
  RETENTION,
  abandonMaintenanceLease,
  claimMaintenance,
  classifyMaintenanceFailure,
  lastMaintenanceAt,
  maintenanceBackoffMs,
  readMaintenanceStatus,
  runCompaction,
  runMaintenance,
  runMaintenanceAsync,
} from './maintenance.js'

// node:sqlite до сих пор помечен как experimental и в старых сборках Node
// отсутствует. Тесты с базой в таком случае пропускаем с внятной причиной
// в названии — так же, как в server/auth/throttle.test.js.
let available = true
let unavailable = ''
try {
  createSqliteDriver(':memory:').close()
} catch (error) {
  available = false
  unavailable = error.message
}

const describeDb = available ? describe : describe.skip
const suiteName = available
  ? 'maintenance'
  : `maintenance — пропущено: node:sqlite недоступен в Node ${process.version} (${unavailable})`

const HASH = 'a'.repeat(64)
const BASE = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

// Схема накатывается тем же раннером, что и на хостинге: тест обязан падать,
// если миграция разойдётся с ожиданиями модуля.
const setup = () => {
  const db = createSqliteDriver(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  // Аренда живёт в модуле, а тесты гоняют десятки соединений подряд: остаток
  // от предыдущего теста не должен закрываться результатом следующего.
  abandonMaintenanceLease()
  return db
}

const addLead = (db, { purgeAfter, phone = '+998900000000' }) =>
  db.run(
    `INSERT INTO leads (created_at, name, phone, ip_hash, purge_after)
     VALUES (?, 'Тест Тестов', ?, ?, ?)`,
    [BASE, phone, HASH, purgeAfter]
  )

const addLeads = (db, count, purgeAfter) => {
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      addLead(db, { purgeAfter, phone: `+99890${String(i).padStart(7, '0')}` })
    }
  })
}

const count = (db, table) => db.get(`SELECT COUNT(*) AS n FROM ${table}`).n

/**
 * Соединение, которое роняет один конкретный запрос.
 *
 * Инъекция отказа делается на уровне драйвера, а не мока модуля: проход обязан
 * пережить отказ ровно там, где он случается в жизни, — посреди удаления,
 * с уже открытой транзакцией и с зафиксированными предыдущими пачками.
 */
const failingOn = (db, fragment, error) => ({
  ...db,
  run: (sql, params) => {
    if (typeof sql === 'string' && sql.includes(fragment)) throw error
    return db.run(sql, params)
  },
})

const diskFull = () => {
  const error = new Error('database or disk is full')
  error.code = 'ERR_SQLITE_ERROR'
  return error
}

describeDb(suiteName, () => {
  describe('runMaintenance', () => {
    it('удаляет заявки с наступившим сроком хранения и оставляет остальные', () => {
      const db = setup()
      addLead(db, { purgeAfter: BASE - 1, phone: '+998900000001' })
      addLead(db, { purgeAfter: BASE, phone: '+998900000002' })
      addLead(db, { purgeAfter: BASE + 1, phone: '+998900000003' })

      const result = runMaintenance(db, { now: BASE })

      // purge_after <= now, то есть ровно наступивший срок тоже считается
      // истёкшим: иначе строка ждала бы следующего прохода лишние сутки.
      expect(result.leads).toBe(2)
      expect(db.all('SELECT phone FROM leads').map((row) => row.phone))
        .toEqual(['+998900000003'])

      db.close()
    })

    // Таблица растёт по строке на каждое нажатие кнопки в чате и никогда
    // не перечитывается дальше окна повторов Telegram. Без этого шага она
    // росла бы всё время жизни установки — а миграция 014 обещает обратное
    // и заводит индекс по received_at именно под эту уборку.
    it('чистит журнал обработанных обновлений Telegram', () => {
      const db = setup()
      db.run(
        `INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?), (?, ?)`,
        [1, BASE - RETENTION.telegramUpdatesMs - 1, 2, BASE - 1000]
      )

      const result = runMaintenance(db, { now: BASE })

      expect(result.telegramUpdates).toBe(1)
      expect(db.all('SELECT update_id FROM telegram_updates').map((row) => row.update_id))
        .toEqual([2])

      db.close()
    })

    it('чистит журналы по своим срокам, не трогая свежие записи', () => {
      const db = setup()
      const old = (ms) => BASE - ms - 1

      db.run(
        `INSERT INTO login_attempts (at, ip_hash, stage, outcome)
         VALUES (?, ?, 'password', 'bad_password'), (?, ?, 'password', 'bad_password')`,
        [old(RETENTION.loginAttemptsMs), HASH, BASE - 1000, HASH]
      )
      db.run(
        `INSERT INTO ip_blocks (ip_hash, blocked_until) VALUES (?, ?), (?, ?)`,
        [HASH, old(RETENTION.ipBlocksMs), 'b'.repeat(64), BASE + DAY]
      )
      db.run(
        `INSERT INTO audit_log (at, actor, action) VALUES (?, 'admin', 'x'), (?, 'admin', 'y')`,
        [old(RETENTION.auditLogMs), BASE - 1000]
      )
      db.run(
        `INSERT INTO translation_jobs (key, lang, source_text, source_hash, status, updated_at)
         VALUES ('a', 'en', 't', 'h', 'done', ?),
                ('b', 'en', 't', 'h', 'queued', ?)`,
        [old(RETENTION.translationJobsMs), old(RETENTION.translationJobsMs)]
      )

      const result = runMaintenance(db, { now: BASE })

      expect(result.loginAttempts).toBe(1)
      expect(result.ipBlocks).toBe(1)
      expect(result.auditLog).toBe(1)
      // Незавершённая задача не история, сколько бы она ни лежала: её ещё
      // предстоит выполнить, и уборка не имеет права её потерять.
      expect(result.translationJobs).toBe(1)
      expect(count(db, 'translation_jobs')).toBe(1)
      expect(db.get('SELECT status FROM translation_jobs').status).toBe('queued')

      db.close()
    })

    it('помечает истёкшие сессии и удаляет отлежавшие', () => {
      const db = setup()
      db.run(
        `INSERT INTO users (username, password_hash, role) VALUES ('admin', 'x', 'owner')`
      )
      const userId = db.get('SELECT id FROM users').id

      const addSession = (id, fields) => db.run(
        `INSERT INTO sessions (id, user_id, csrf_hash, ip_hash, ua_hash,
                               idle_expires_at, absolute_expires_at, revoked_at, revoked_reason)
         VALUES (?, ?, 'h', ?, ?, ?, ?, ?, ?)`,
        [
          id, userId, HASH, HASH,
          fields.idle, fields.absolute,
          fields.revokedAt ?? null,
          fields.revokedAt == null ? null : 'logout',
        ]
      )

      addSession('1'.repeat(64), { idle: BASE - 1, absolute: BASE + DAY })
      addSession('2'.repeat(64), { idle: BASE + DAY, absolute: BASE + DAY })
      addSession('3'.repeat(64), {
        idle: BASE, absolute: BASE, revokedAt: BASE - 8 * DAY,
      })

      const result = runMaintenance(db, { now: BASE })

      expect(result.sessions.expired).toBe(1)
      expect(result.sessions.deleted).toBe(1)
      expect(count(db, 'sessions')).toBe(2)

      db.close()
    })

    it('убирает отработавшие окна лимитера', () => {
      const db = setup()
      // Таблицу заводит сам лимитер (см. комментарий в 001_init.sql), поэтому
      // до первого runMaintenance её ещё нет — создаём тем же запросом.
      runMaintenance(db, { now: BASE })
      db.run(
        `INSERT INTO rate_limit (bucket, window_start, window_ms, count)
         VALUES ('old', ?, 60000, 3), ('fresh', ?, 60000, 1)`,
        [BASE - 10 * 60_000, BASE]
      )

      expect(runMaintenance(db, { now: BASE }).rateLimit).toBe(1)
      expect(count(db, 'rate_limit')).toBe(1)

      db.close()
    })

    it('не переставляет расписание при вызове без захвата аренды', () => {
      const db = setup()
      claimMaintenance(db, { now: BASE })
      runMaintenance(db, { now: BASE })
      abandonMaintenanceLease()

      // Ручной запуск (команда CLI) не должен сдвигать расписание сервера:
      // иначе одна проверка руками отменяла бы автоматический проход.
      runMaintenance(db, { now: BASE + 5 * DAY })

      expect(lastMaintenanceAt(db)).toBe(BASE)
      expect(readMaintenanceStatus(db).purge.nextRunAt).toBe(BASE + MAINTENANCE_INTERVAL_MS)

      db.close()
    })
  })

  describe('пакетное удаление (CR-043)', () => {
    it('удаляет весь хвост несколькими пачками', () => {
      const db = setup()
      addLeads(db, 47, BASE - 1)

      const result = runMaintenance(db, { now: BASE, batchSize: 5 })

      expect(result.leads).toBe(47)
      expect(result.truncated).toBe(false)
      expect(count(db, 'leads')).toBe(0)

      db.close()
    })

    it('уступает цикл событий между пачками', async () => {
      const db = setup()
      addLeads(db, 200, BASE - 1)

      // Счётчик тиков вместо замера «сколько миллисекунд не отвечал процесс»:
      // абсолютное время зависит от машины, а вот факт «между пачками цикл
      // событий успел выполнить чужой колбэк» — нет.
      let ticks = 0
      let longestGapMs = 0
      let previous = performance.now()
      let running = true
      const tick = () => {
        if (!running) return
        const at = performance.now()
        longestGapMs = Math.max(longestGapMs, at - previous)
        previous = at
        ticks += 1
        setImmediate(tick)
      }
      setImmediate(tick)

      const result = await runMaintenanceAsync(db, { now: BASE, batchSize: 10 })
      running = false

      expect(result.leads).toBe(200)
      expect(count(db, 'leads')).toBe(0)
      // 20 пачек по заявкам плюс по одной на каждую оставшуюся таблицу.
      expect(ticks).toBeGreaterThanOrEqual(15)
      // Верхняя граница щедрая намеренно: тест проверяет, что уступка ЕСТЬ,
      // а не скорость конкретной машины.
      expect(longestGapMs).toBeLessThan(1_000)

      db.close()
    })

    it('останавливается по бюджету времени и помечает проход неполным', () => {
      const db = setup()
      addLeads(db, 10, BASE - 1)
      claimMaintenance(db, { now: BASE })

      // Управляемые монотонные часы: каждое обращение — плюс секунда.
      let clock = 0
      const monotonic = () => {
        clock += 1_000
        return clock
      }

      const result = runMaintenance(db, {
        now: BASE,
        batchSize: 2,
        timeBudgetMs: 1_500,
        monotonic,
      })

      expect(result.truncated).toBe(true)
      // Две пачки успели пройти, остальное осталось следующему проходу.
      expect(result.leads).toBe(4)
      expect(count(db, 'leads')).toBe(6)

      const status = readMaintenanceStatus(db).purge
      // Неполный проход — успех с хвостом: сутки ждать нельзя, работа известна.
      expect(status.lastTruncated).toBe(true)
      expect(status.nextRunAt).toBe(BASE + MAINTENANCE_RETRY_MS)
      expect(status.lastSuccessAt).toBe(BASE)

      db.close()
    })

    it('бюджет времени по умолчанию короче аренды', () => {
      // Иначе живой проход у самого себя отберут на последней пачке.
      expect(MAINTENANCE_TIME_BUDGET_MS).toBeLessThan(MAINTENANCE_LEASE_MS)
    })
  })

  describe('claimMaintenance', () => {
    it('отдаёт право ровно одному из нескольких претендентов', () => {
      const db = setup()
      // Так выглядит пул процессов Passenger: таймер завёлся в каждом, все
      // проснулись в одну секунду и пришли к одной и той же базе.
      const claims = [0, 0, 0, 0].map(() => claimMaintenance(db, { now: BASE }))

      expect(claims.filter(Boolean)).toHaveLength(1)

      db.close()
    })

    it('после успеха ждёт обычный интервал', () => {
      const db = setup()

      expect(claimMaintenance(db, { now: BASE })).toBe(true)
      runMaintenance(db, { now: BASE })

      expect(lastMaintenanceAt(db)).toBe(BASE)
      expect(claimMaintenance(db, { now: BASE + MAINTENANCE_INTERVAL_MS - 1 })).toBe(false)
      expect(claimMaintenance(db, { now: BASE + MAINTENANCE_INTERVAL_MS })).toBe(true)

      db.close()
    })

    it('падение сразу после захвата не откладывает работу на сутки', () => {
      const db = setup()

      expect(claimMaintenance(db, { now: BASE })).toBe(true)
      // Процесс умер строкой позже захвата: ни успеха, ни отказа записано
      // не будет. Именно этот сценарий до CR-043 стоил суток простоя, а вместе
      // с ними — ненаступившего срока хранения ПДн.
      abandonMaintenanceLease()

      expect(lastMaintenanceAt(db)).toBeNull()
      // Пока аренда жива, работу не заберёт никто: иначе весь пул кинулся бы
      // повторять её вслед за упавшим.
      expect(claimMaintenance(db, { now: BASE + MINUTE })).toBe(false)
      expect(claimMaintenance(db, { now: BASE + MAINTENANCE_LEASE_MS - 1 })).toBe(false)
      // А как только истекла — первый же таймер продолжает работу.
      expect(claimMaintenance(db, { now: BASE + MAINTENANCE_LEASE_MS })).toBe(true)
      expect(MAINTENANCE_LEASE_MS).toBeLessThan(DAY)

      db.close()
    })

    it('после отказа ждёт короткий ограниченный backoff', () => {
      const db = setup()
      addLead(db, { purgeAfter: BASE - 1 })
      db.run(`INSERT INTO audit_log (at, actor, action) VALUES (?, 'admin', 'x')`, [
        BASE - RETENTION.auditLogMs - 1,
      ])

      const broken = failingOn(db, 'DELETE FROM audit_log', diskFull())
      expect(claimMaintenance(broken, { now: BASE })).toBe(true)
      expect(() => runMaintenance(broken, { now: BASE })).toThrow(/disk is full/)

      const status = readMaintenanceStatus(db).purge
      expect(status.lastSuccessAt).toBeNull()
      expect(status.lastFailureAt).toBe(BASE)
      expect(status.failureCategory).toBe('storage')
      expect(status.failureStreak).toBe(1)
      expect(status.leaseOwner).toBeNull()
      expect(status.nextRunAt).toBe(BASE + MAINTENANCE_RETRY_MS)

      // Пачки, прошедшие до отказа, зафиксированы: откатывать удалённые ПДн
      // из-за отказа на следующей таблице незачем.
      expect(count(db, 'leads')).toBe(0)

      expect(claimMaintenance(db, { now: BASE + MAINTENANCE_RETRY_MS - 1 })).toBe(false)
      expect(claimMaintenance(db, { now: BASE + MAINTENANCE_RETRY_MS })).toBe(true)

      db.close()
    })

    it('наращивает backoff по серии отказов и упирается в потолок', () => {
      const db = setup()
      db.run(`INSERT INTO audit_log (at, actor, action) VALUES (?, 'admin', 'x')`, [
        BASE - RETENTION.auditLogMs - 1,
      ])
      const broken = failingOn(db, 'DELETE FROM audit_log', diskFull())

      let at = BASE
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(claimMaintenance(broken, { now: at })).toBe(true)
        expect(() => runMaintenance(broken, { now: at })).toThrow()
        const status = readMaintenanceStatus(db).purge
        expect(status.failureStreak).toBe(attempt)
        expect(status.nextRunAt).toBe(at + maintenanceBackoffMs(attempt))
        at = status.nextRunAt
      }

      // Ограниченность — обязательное свойство: заклинившая по постоянной
      // причине уборка не должна ни долбить базу, ни уйти в бесконечность.
      for (let streak = 1; streak <= 25; streak += 1) {
        const backoff = maintenanceBackoffMs(streak)
        expect(backoff).toBeGreaterThanOrEqual(MAINTENANCE_RETRY_MS)
        expect(backoff).toBeLessThanOrEqual(MAINTENANCE_RETRY_MAX_MS)
        expect(backoff).toBeLessThan(MAINTENANCE_INTERVAL_MS)
      }

      db.close()
    })

    it('успех после отказов обнуляет серию и возвращает обычный интервал', () => {
      const db = setup()
      db.run(`INSERT INTO audit_log (at, actor, action) VALUES (?, 'admin', 'x')`, [
        BASE - RETENTION.auditLogMs - 1,
      ])
      const broken = failingOn(db, 'DELETE FROM audit_log', diskFull())

      claimMaintenance(broken, { now: BASE })
      expect(() => runMaintenance(broken, { now: BASE })).toThrow()

      const retryAt = BASE + MAINTENANCE_RETRY_MS
      expect(claimMaintenance(db, { now: retryAt })).toBe(true)
      runMaintenance(db, { now: retryAt })

      const status = readMaintenanceStatus(db).purge
      expect(status.failureStreak).toBe(0)
      expect(status.failureCategory).toBeNull()
      expect(status.lastSuccessAt).toBe(retryAt)
      expect(status.nextRunAt).toBe(retryAt + MAINTENANCE_INTERVAL_MS)
      expect(status.lastDurationMs).toBeGreaterThanOrEqual(0)

      db.close()
    })

    it('отвергает нецелые аргументы', () => {
      const db = setup()

      expect(() => claimMaintenance(db, { now: 1.5 })).toThrow(TypeError)
      expect(() => claimMaintenance(db, { intervalMs: 0 })).toThrow(TypeError)
      expect(() => claimMaintenance(db, { leaseMs: -1 })).toThrow(TypeError)

      db.close()
    })
  })

  describe('runCompaction (CR-043)', () => {
    it('не выполняется в двух процессах одновременно', () => {
      const db = setup()

      const first = runCompaction(db, { now: BASE, owner: 'worker-1', token: 't1' })
      const second = runCompaction(db, { now: BASE, owner: 'worker-2', token: 't2' })

      expect(first.ran).toBe(true)
      expect(second.ran).toBe(false)

      db.close()
    })

    it('измеряет длительность отдельно от уборки', () => {
      const db = setup()
      claimMaintenance(db, { now: BASE })
      runMaintenance(db, { now: BASE })

      const compaction = runCompaction(db, { now: BASE, owner: 'worker-1', token: 't1' })

      expect(compaction.ran).toBe(true)
      expect(compaction.optimizeMs).toBeGreaterThanOrEqual(0)
      expect(compaction.checkpointMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(compaction.durationMs)).toBe(true)

      const status = readMaintenanceStatus(db)
      // Два разных диагноза — «уборка стала медленной» и «контрольная точка
      // стала медленной» — и потому две разные строки состояния.
      expect(status.compact.lastSuccessAt).toBe(BASE)
      expect(status.compact.lastDurationMs).toBeGreaterThanOrEqual(0)
      expect(status.purge.lastSuccessAt).toBe(BASE)

      db.close()
    })
  })

  describe('срок хранения заявок (CR-043)', () => {
    it('совпадает со сроком, который проставляет репозиторий заявок', () => {
      const db = setup()
      const repository = createLeadRepository(db)

      const created = repository.createPending({
        lead: { name: 'Test User', phone: '+998900000000', message: 'Тестовая заявка, игнорировать' },
        context: { ipHash: HASH, userAgentHash: 'b'.repeat(64) },
        metadata: { locale: 'ru', pagePath: '/' },
        idempotencyKey: 'retention-policy-test-0001',
        now: BASE,
      })
      expect(created.created).toBe(true)

      const purgeAfter = db.get('SELECT purge_after FROM leads').purge_after
      // Расхождение здесь означает, что сайт обещает клиенту один срок
      // хранения персональных данных, а база выполняет другой.
      expect(purgeAfter - BASE).toBe(RETENTION.leadsMs)
      expect(RETENTION.leadsMs).toBe(365 * DAY)

      // И этот же срок наступает сам, без чьей-либо кнопки.
      expect(runMaintenance(db, { now: BASE + RETENTION.leadsMs - 1 }).leads).toBe(0)
      expect(runMaintenance(db, { now: BASE + RETENTION.leadsMs }).leads).toBe(1)

      db.close()
    })
  })

  describe('classifyMaintenanceFailure', () => {
    it('раскладывает отказы по действиям дежурного', () => {
      expect(classifyMaintenanceFailure(new Error('database is locked'))).toBe('busy')
      expect(classifyMaintenanceFailure(new Error('database or disk is full'))).toBe('storage')
      expect(classifyMaintenanceFailure(new Error('attempt to write a readonly database')))
        .toBe('readonly')
      expect(classifyMaintenanceFailure(new Error('no such table: leads'))).toBe('schema')
      expect(classifyMaintenanceFailure(new Error('нечто новое'))).toBe('unknown')
      // Категория попадает в дашборд, поэтому сама ошибка в неё не просачивается.
      expect(classifyMaintenanceFailure(new Error('/home/app/data/app.sqlite'))).toBe('unknown')
    })
  })

  describe('lastMaintenanceAt', () => {
    it('возвращает null, пока успешной уборки не было', () => {
      const db = setup()
      expect(lastMaintenanceAt(db)).toBeNull()
      db.close()
    })
  })

  describe('readMaintenanceStatus', () => {
    it('описывает обе задачи ещё до первого прохода', () => {
      const db = setup()
      const status = readMaintenanceStatus(db)

      for (const task of ['purge', 'compact']) {
        expect(status[task]).toMatchObject({
          task,
          leaseOwner: null,
          nextRunAt: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          failureCategory: null,
          failureStreak: 0,
          lastDurationMs: null,
          lastTruncated: false,
        })
      }

      db.close()
    })

    it('показывает живую аренду во время прохода', () => {
      const db = setup()
      claimMaintenance(db, { now: BASE, owner: 'worker-7' })

      const status = readMaintenanceStatus(db).purge
      expect(status.leaseOwner).toBe('worker-7')
      expect(status.leaseUntil).toBe(BASE + MAINTENANCE_LEASE_MS)
      expect(status.startedAt).toBe(BASE)

      abandonMaintenanceLease()
      db.close()
    })
  })
})
