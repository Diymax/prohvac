// Проводка маршрута входа к двум независимым защитам: ведёрному лимитеру
// (server/lib/ratelimit.js) и эскалации по адресу (server/auth/throttle.js).
//
// Сами защиты покрыты своими тестами. Здесь проверяется ровно стык — то место,
// где эскалация однажды и оказалась отключённой: модуль существовал, был
// протестирован и не вызывался ниоткуда, кроме ловушки для сканеров.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { createRouter } from '../router.js'
import { registerAdminAuthRoutes } from './admin.auth.js'

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
  ? 'registerAdminAuthRoutes — POST /api/admin/session'
  : `admin.auth — пропущено: node:sqlite недоступен в Node ${process.version} (${unavailable})`

const SCHEMA = readFileSync(
  join(import.meta.dirname, '..', 'db', 'migrations', '001_init.sql'),
  'utf8'
).replace(/^\uFEFF/, '')

/** Ответ, из которого тесту нужны только статус и тело. */
const fakeRes = () => {
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    headers: {},
    body: '',
    setHeader (name, value) { this.headers[name.toLowerCase()] = value },
    getHeader (name) { return this.headers[name.toLowerCase()] },
    removeHeader (name) { delete this.headers[name.toLowerCase()] },
    end (chunk) {
      this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
      this.writableEnded = true
    },
  }
  return res
}

const fakeReq = (payload) => {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
  req.method = 'POST'
  req.url = '/api/admin/session'
  req.headers = { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' }
  req.socket = { remoteAddress: '203.0.113.9' }
  return req
}

const allowingThrottle = () => ({
  hit: vi.fn(() => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
  reset: vi.fn(),
})

const spyEscalation = () => ({
  registerFailure: vi.fn(() => ({ blocked: false, until: 0, delayMs: 0, reason: null, fails: 1 })),
})

/**
 * Поднимает маршруты на своей базе и отдаёт функцию «выполнить вход».
 * Пароль проверяется настоящим scrypt, поэтому один вызов стоит сотни
 * миллисекунд — тесты держат их поштучно.
 */
const setup = (deps = {}) => {
  const db = createSqliteDriver(':memory:')
  db.exec(SCHEMA)

  const throttle = deps.throttle ?? allowingThrottle()
  const escalation = deps.escalation ?? spyEscalation()

  const router = createRouter()
  registerAdminAuthRoutes(router, { db, throttle, escalation })
  const { handler } = router.match('POST', '/api/admin/session')

  const login = async (payload) => {
    const res = fakeRes()
    await handler(fakeReq(payload), res)
    return res
  }

  return { db, throttle, escalation, login }
}

describeDb(suiteName, () => {
  it('передаёт неудачу в эскалацию по адресу', async () => {
    const { db, escalation, login } = setup()

    const res = await login({ username: 'admin', password: 'wrong-password' })

    expect(res.statusCode).toBe(401)
    expect(escalation.registerFailure).toHaveBeenCalledTimes(1)
    expect(escalation.registerFailure.mock.calls[0][0]).toMatchObject({
      username: 'admin',
      stage: 'password',
      outcome: 'unknown_user',
      // Строку в login_attempts уже написал сам маршрут: повторная запись
      // удвоила бы счётчик неудач, то есть и наказание.
      record: false,
    })

    // Попытка при этом записана ровно один раз.
    expect(db.get('SELECT COUNT(*) AS n FROM login_attempts').n).toBe(1)

    db.close()
  })

  it('не меняет ответ, когда эскалация заблокировала адрес', async () => {
    const escalation = {
      registerFailure: vi.fn(() => ({
        blocked: true, until: Date.now() + 86_400_000, delayMs: 0, reason: 'ip_blocked', fails: 20,
      })),
    }
    const { db, login } = setup({ escalation })

    const res = await login({ username: 'admin', password: 'wrong-password' })

    // Отдельный код ответа на «адрес только что забанили» — оракул, по которому
    // подбирается сам порог. Блокировка обязана проявиться только на следующем
    // запросе, в dispatch (server/app.js), и выглядеть как неизвестный адрес.
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'invalid_credentials' })

    db.close()
  })

  it('не роняет вход, если эскалация бросила', async () => {
    const escalation = {
      registerFailure: vi.fn(() => { throw new Error('база недоступна') }),
    }
    const { db, login } = setup({ escalation })

    const res = await login({ username: 'admin', password: 'wrong-password' })

    expect(res.statusCode).toBe(401)

    db.close()
  })

  it('не заводит ведро логина, когда лимит по адресу исчерпан', async () => {
    // count намеренно занижен: по нему считается прогрессивная задержка, и
    // реальные 30+ неудач заставили бы тест честно ждать её потолок в 5 секунд.
    // Проверяется здесь не задержка, а то, какие вёдра были затронуты.
    const throttle = {
      hit: vi.fn(() => ({ allowed: false, count: 3, resetAt: Date.now() + 60_000 })),
      reset: vi.fn(),
    }
    const { db, login } = setup({ throttle })

    const res = await login({ username: 'какой-угодно-новый-логин', password: 'x' })

    expect(res.statusCode).toBe(429)
    // Ровно один hit — по адресу. Ведро логина трогать нельзя: имя приходит
    // из тела, и поток уникальных имён иначе растил бы таблицу rate_limit
    // неаутентифицированными запросами, потому что hit() вставляет строку
    // ДО того, как вызывающий посмотрит на allowed.
    expect(throttle.hit).toHaveBeenCalledTimes(1)
    expect(throttle.hit.mock.calls[0][0]).toMatch(/^login:ip:/)

    db.close()
  })

  it('заводит оба ведра, пока лимит по адресу не исчерпан', async () => {
    const { db, throttle, login } = setup()

    await login({ username: 'admin', password: 'wrong-password' })

    expect(throttle.hit).toHaveBeenCalledTimes(2)
    expect(throttle.hit.mock.calls[1][0]).toBe('login:user:admin')

    db.close()
  })

  it('создаёт эскалацию сам, если её не передали', () => {
    const db = createSqliteDriver(':memory:')
    db.exec(SCHEMA)

    // Умолчание важнее внедрения: в проде deps.escalation никто не передаёт,
    // и именно отсутствующее умолчание оставило бы защиту выключенной.
    expect(() => registerAdminAuthRoutes(createRouter(), { db })).not.toThrow()

    db.close()
  })
})
