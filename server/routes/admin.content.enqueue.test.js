// CR-062. Возврат задачи перевода в очередь обязан снимать аренду CR-039.
//
// Строка со status = 'queued' и живыми claim_owner/claim_token/claim_until
// утверждает, что работу кто-то держит, хотя работа ещё не начата. Сегодня это
// никого не путает — каждый потребитель аренды требует status = 'running', —
// но именно такое расхождение состояния с реальностью аренда и заводилась
// убрать, а потребитель, который однажды посмотрит только на claim_until,
// напишется без единого сигнала о том, что так делать нельзя.

import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { config } from '../config.js'
import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createRouter } from '../router.js'
import { registerAdminContentRoutes } from './admin.content.js'

let available = true
try {
  createSqliteDriver(':memory:').close()
} catch {
  available = false
}

const describeDb = available ? describe : describe.skip

const CLIENT_IP = '203.0.113.44'
const CLIENT_UA = 'content-enqueue-test'
const KEY = 'hero.title'

const fakeRes = () => ({
  statusCode: 200,
  headersSent: false,
  writableEnded: false,
  headers: {},
  body: '',
  setHeader (name, value) {
    this.headers[name.toLowerCase()] = value
  },
  getHeader (name) {
    return this.headers[name.toLowerCase()]
  },
  removeHeader (name) {
    delete this.headers[name.toLowerCase()]
  },
  end (chunk) {
    this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    this.writableEnded = true
  },
})

const fakeReq = ({ method, url, token, csrfToken, body }) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  req.headers = {
    origin: config.publicOrigin,
    'user-agent': CLIENT_UA,
    'x-real-ip': CLIENT_IP,
    cookie: `${SESSION_COOKIE}=${token}`,
    'x-csrf-token': csrfToken,
    'content-type': 'application/json',
  }
  req.socket = { remoteAddress: CLIENT_IP }
  return req
}

const setup = () => {
  const db = createSqliteDriver(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)

  const inserted = db.run(
    `INSERT INTO users (username, password_hash, role, must_change_password, totp_required)
     VALUES ('content-owner', 'test-only-hash', 'owner', 0, 0)`
  )
  const session = createSession(db, {
    userId: Number(inserted.lastInsertRowid),
    state: 'active',
    ip: CLIENT_IP,
    ua: CLIENT_UA,
  })

  // deps без enqueueTranslation намеренно: проверяется запасная постановка
  // из самого маршрута, то есть тот самый SQL_ENQUEUE_JOB.
  const router = createRouter()
  registerAdminContentRoutes(router, { db })

  const saveSource = async (value) => {
    const url = `/api/admin/content/${KEY}`
    const matched = router.match('PUT', url)
    const response = fakeRes()
    await matched.handler(
      fakeReq({
        method: 'PUT',
        url,
        token: session.token,
        csrfToken: session.csrfToken,
        body: { lang: 'ru', value },
      }),
      response,
      matched.params
    )
    return { response, payload: response.body ? JSON.parse(response.body) : null }
  }

  return { db, saveSource }
}

describeDb('перепостановка задачи перевода (CR-062)', () => {
  it('снимает аренду прошлого исполнителя тем же запросом', async () => {
    const { db, saveSource } = setup()

    const first = await saveSource('Первый текст')
    expect(first.response.statusCode).toBe(200)
    expect(first.payload.queued).toContain('en')

    // Воркер взял задачу в работу: status = 'running' и живая аренда CR-039.
    const claimUntil = Date.now() + 60_000
    db.run(
      `UPDATE translation_jobs
          SET status = 'running', claim_owner = ?, claim_token = ?, claim_until = ?
        WHERE key = ? AND lang = 'en'`,
      ['worker-1', 'claim-token-0001', claimUntil, KEY]
    )

    // Редактор правит исходник, пока перевод выполняется: задача возвращается
    // в очередь по ON CONFLICT, потому что текст, который она переводит,
    // больше не актуален.
    const second = await saveSource('Второй текст')
    expect(second.response.statusCode).toBe(200)

    const job = db.get(
      `SELECT status, claim_owner, claim_token, claim_until, source_text
         FROM translation_jobs WHERE key = ? AND lang = 'en'`,
      [KEY]
    )
    expect(job.status).toBe('queued')
    expect(job.source_text).toBe('Второй текст')
    expect(job.claim_owner).toBeNull()
    expect(job.claim_token).toBeNull()
    // 0, а не NULL: колонка объявлена NOT NULL DEFAULT 0 — «аренды нет».
    expect(job.claim_until).toBe(0)

    db.close()
  })

  it('не оставляет остаточной аренды ни на одной из перепоставленных задач', async () => {
    const { db, saveSource } = setup()

    await saveSource('Первый текст')
    db.run(
      `UPDATE translation_jobs
          SET claim_owner = 'worker-1', claim_token = 'claim-token-0002', claim_until = ?`,
      [Date.now() + 60_000]
    )

    await saveSource('Второй текст')

    const stale = db.get(
      `SELECT COUNT(*) AS n FROM translation_jobs
        WHERE claim_owner IS NOT NULL OR claim_token IS NOT NULL OR claim_until <> 0`
    ).n
    expect(stale).toBe(0)

    db.close()
  })
})
