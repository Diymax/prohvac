// Сводка Метрики в админке: что уходит в API, что возвращается оператору
// и что он видит, когда Яндекс не ответил.
//
// fetch подменяется целиком: сеть в тестах не нужна, а проверять надо ровно
// две вещи — как собирается запрос и как классифицируется отказ.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { METRICA_COUNTER_ID, METRICA_GOALS } from '../../shared/analytics.js'
import { createMetricaGateway } from '../integrations/metrica.js'
import { DEFAULT_PERIOD, buildAnalyticsDashboard } from './analytics-dashboard.js'

let available = true
try {
  const { DatabaseSync } = await import('node:sqlite')
  new DatabaseSync(':memory:').close()
} catch {
  available = false
}

const describeDb = available ? describe : describe.skip

const migrationsDir = join(import.meta.dirname, '..', 'db', 'migrations')

/** База со схемой и обёрткой get/run, какую ждёт дашборд. */
const freshDb = async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(':memory:')
  for (const file of readdirSync(migrationsDir).sort()) {
    raw.exec(readFileSync(join(migrationsDir, file), 'utf8'))
  }
  return {
    raw,
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
  }
}

const TOKEN = 'y0_test-token-value-0123456789'

/** Ответы Яндекса по умолчанию: цели, сводка, источники. */
const okFetch = (calls = []) => async (url) => {
  const address = String(url)
  calls.push(address)
  if (address.includes('/goals')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        goals: [
          { id: 111, name: METRICA_GOALS.FORM_SUBMIT },
          { id: 222, name: METRICA_GOALS.PHONE_CLICK },
          { id: 333, name: 'чужая цель' },
        ],
      }),
    }
  }
  if (address.includes('dimensions=')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ dimensions: [{ name: 'Поисковые системы' }], metrics: [820] }],
      }),
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ totals: [1200, 940, 31.5, 84, 42, 3.5, 77, 6.4], sampled: false }),
  }
}

describe('шлюз Метрики', () => {
  it('кладёт токен в заголовок, а не в строку запроса', async () => {
    let seen = null
    const gateway = createMetricaGateway({
      fetchImpl: async (url, options) => {
        seen = { url: String(url), options }
        return { ok: true, status: 200, json: async () => ({}) }
      },
    })

    await gateway.stat({ token: TOKEN, counterId: 42, metrics: 'ym:s:visits', date1: '7daysAgo', date2: 'yesterday' })

    // Строка запроса оседает в логах прокси и в истории, заголовок — нет.
    expect(seen.url).not.toContain(TOKEN)
    expect(seen.options.headers.Authorization).toBe(`OAuth ${TOKEN}`)
    expect(seen.url).toContain('ids=42')
    // Без accuracy=full Яндекс вправе ответить по выборке, и число визитов
    // на дашборде не сойдётся с интерфейсом Метрики.
    expect(seen.url).toContain('accuracy=full')
  })

  it('без токена наружу не ходит вовсе', async () => {
    let called = false
    const gateway = createMetricaGateway({
      fetchImpl: async () => {
        called = true
        return { ok: true, status: 200, json: async () => ({}) }
      },
    })

    const result = await gateway.stat({ token: '', counterId: 42 })

    expect(called).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'not_configured' })
  })

  it('различает причины отказа, а не сводит их к одной ошибке', async () => {
    const cases = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [429, 'rate_limited'],
      [400, 'bad_request'],
      [503, 'upstream_failed'],
    ]

    for (const [status, error] of cases) {
      const gateway = createMetricaGateway({
        fetchImpl: async () => ({ ok: false, status, json: async () => ({ message: 'нет' }) }),
      })
      const result = await gateway.stat({ token: TOKEN, counterId: 42 })
      expect(result).toMatchObject({ ok: false, error, status })
    }
  })

  it('не пропускает токен в текст ошибки', async () => {
    const gateway = createMetricaGateway({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: `OAuth ${TOKEN} is invalid` }),
      }),
    })

    const result = await gateway.stat({ token: TOKEN, counterId: 42 })

    expect(result.message).not.toContain(TOKEN)
    expect(result.message).toContain('[redacted]')
  })
})

describeDb('сводка аналитики', () => {
  it('делает три запроса и находит цели по имени', async () => {
    const db = await freshDb()
    const calls = []
    const gateway = createMetricaGateway({ fetchImpl: okFetch(calls) })

    const dashboard = await buildAnalyticsDashboard({ db, gateway, token: TOKEN, period: '30d' })

    expect(calls).toHaveLength(3)
    expect(dashboard.summary.visits).toBe(1200)
    // Цели ищутся по имени: числовой id в коде показывал бы нули после того,
    // как цель пересоздали в интерфейсе Метрики.
    expect(dashboard.summary.goals[METRICA_GOALS.FORM_SUBMIT]).toEqual({
      reaches: 42,
      conversionRate: 3.5,
    })
    expect(dashboard.knownGoals['чужая цель']).toBeUndefined()
    expect(dashboard.missingGoals).toEqual([])
    expect(dashboard.counterId).toBe(METRICA_COUNTER_ID)
    db.raw.close()
  })

  it('второй вызов берёт данные из кэша', async () => {
    const db = await freshDb()
    const calls = []
    const gateway = createMetricaGateway({ fetchImpl: okFetch(calls) })

    await buildAnalyticsDashboard({ db, gateway, token: TOKEN, period: '7d' })
    const after = calls.length
    await buildAnalyticsDashboard({ db, gateway, token: TOKEN, period: '7d' })

    expect(calls).toHaveLength(after)
    db.raw.close()
  })

  it('при отказе Яндекса показывает последние удачные цифры как устаревшие', async () => {
    const db = await freshDb()
    const gateway = createMetricaGateway({ fetchImpl: okFetch() })
    await buildAnalyticsDashboard({ db, gateway, token: TOKEN, period: '30d' })

    const failing = createMetricaGateway({
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    })
    // Час спустя: кэш просрочен, запрос не удался.
    const dashboard = await buildAnalyticsDashboard({
      db,
      gateway: failing,
      token: TOKEN,
      period: '30d',
      now: Date.now() + 60 * 60 * 1000,
    })

    // Пустой экран с ошибкой хуже старых цифр с честной пометкой.
    expect(dashboard.error).toBe('unauthorized')
    expect(dashboard.stale).toBe(true)
    expect(dashboard.summary.visits).toBe(1200)
    db.raw.close()
  })

  it('без токена не ходит в API, но считает заявки из своей базы', async () => {
    const db = await freshDb()
    db.run(
      `INSERT INTO leads (created_at, name, phone, message, locale, ip_hash, purge_after)
       VALUES (?, 'Тест Тестов', '+998900000000', '', 'ru', ?, ?)`,
      [Date.now(), 'a'.repeat(64), Date.now() + 1_000_000]
    )
    let called = false
    const gateway = createMetricaGateway({
      fetchImpl: async () => {
        called = true
        return { ok: true, status: 200, json: async () => ({}) }
      },
    })

    const dashboard = await buildAnalyticsDashboard({ db, gateway, token: '', period: '30d' })

    expect(called).toBe(false)
    expect(dashboard.error).toBe('not_configured')
    expect(dashboard.configured).toBe(false)
    // Сверка со своим журналом работает и без Метрики.
    expect(dashboard.leads).toBe(1)
    db.raw.close()
  })

  it('неизвестный период откатывается к умолчанию', async () => {
    const db = await freshDb()
    const gateway = createMetricaGateway({ fetchImpl: okFetch() })

    // Значение приходит из адресной строки и уходит в запрос к Яндексу.
    const dashboard = await buildAnalyticsDashboard({
      db,
      gateway,
      token: TOKEN,
      period: "'; DROP TABLE leads; --",
    })

    expect(dashboard.period).toBe(DEFAULT_PERIOD)
    expect(db.get('SELECT COUNT(*) AS n FROM leads').n).toBe(0)
    db.raw.close()
  })
})
