// Сводка Яндекс.Метрики для админки: что запросить, как сложить и что
// показать, когда Яндекс не ответил.
//
// ГРАНИЦА ОТВЕТСТВЕННОСТИ. Здесь нет ни HTTP-транспорта (он в
// integrations/metrica.js), ни проверки прав (она в маршруте). Здесь —
// решение, какие отчёты нужны, и правило, по которому дашборд остаётся
// полезным при недоступном API.
//
// ТРИ ЗАПРОСА, НЕ БОЛЬШЕ. Квота Stat API — 200 запросов за 5 минут, и хотя
// упереться в неё с одним экраном трудно, каждый лишний запрос удлиняет
// открытие страницы. Поэтому: цели (список), сводные метрики, источники.
// Разрезы, которые можно получить из уже полученного, добираются на клиенте.
//
// ЦЕЛИ ИЩУТСЯ ПО ИМЕНИ. Числовой id цели в коде — это отчёт, который молча
// показывает нули после того, как цель пересоздали в интерфейсе Метрики.
// Имена (form_submit, phone_click) лежат в shared/analytics.js и совпадают
// с тем, что вызывает форма.

import { METRICA_COUNTER_ID, METRICA_GOALS } from '../../shared/analytics.js'

// Периоды заданы списком, а не принимаются числом: значение приходит из
// адресной строки админки и уходит в запрос к Яндексу, поэтому набор
// допустимых значений должен быть закрытым.
export const PERIODS = Object.freeze({
  '7d': { date1: '7daysAgo', days: 7, title: '7 дней' },
  '30d': { date1: '30daysAgo', days: 30, title: '30 дней' },
  '90d': { date1: '90daysAgo', days: 90, title: '90 дней' },
})

export const DEFAULT_PERIOD = '30d'

// Данные за текущий день неполны, поэтому период всегда заканчивается вчера:
// иначе последняя точка каждого графика была бы обрывом вниз, и её каждый раз
// принимали бы за падение трафика.
const DATE2 = 'yesterday'

const SUMMARY_TTL_MS = 30 * 60 * 1000
// Список целей меняется раз в жизни счётчика — держим сутки.
const GOALS_TTL_MS = 24 * 60 * 60 * 1000

const cacheKey = (report, period) => `${report}:${period}`

const readCache = (db, key, { now }) => {
  const row = db.get('SELECT payload, fetched_at, expires_at FROM metrica_cache WHERE key = ?', [key])
  if (!row) return null
  try {
    return {
      value: JSON.parse(row.payload),
      fetchedAt: Number(row.fetched_at),
      // Просроченная запись возвращается тоже: она пригодится, если запрос
      // к Яндексу не удастся (см. шапку файла).
      fresh: Number(row.expires_at) > now,
    }
  } catch {
    // Битый JSON — это отсутствие кэша, а не повод падать.
    return null
  }
}

const writeCache = (db, key, value, { now, ttlMs }) => {
  db.run(
    `INSERT INTO metrica_cache (key, payload, fetched_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       payload = excluded.payload,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [key, JSON.stringify(value), now, now + ttlMs]
  )
}

/** Число из ответа Stat API: null и мусор превращаются в 0, а не в NaN. */
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/**
 * Кэшированный запрос. Правило простое: свежий кэш — отдаём сразу; иначе
 * идём в API; не получилось — отдаём просроченный кэш, если он есть.
 */
const cached = async (db, key, ttlMs, now, load) => {
  const hit = readCache(db, key, { now })
  if (hit?.fresh) return { value: hit.value, fetchedAt: hit.fetchedAt, stale: false, error: null }

  const result = await load()
  if (result.ok) {
    writeCache(db, key, result.value, { now, ttlMs })
    return { value: result.value, fetchedAt: now, stale: false, error: null }
  }

  if (hit) return { value: hit.value, fetchedAt: hit.fetchedAt, stale: true, error: result.error }
  return { value: null, fetchedAt: null, stale: false, error: result.error }
}

/**
 * Цели счётчика: имя -> id. Берутся только те, что объявлены в
 * shared/analytics.js: чужие цели на дашборде лендинга — шум.
 */
const loadGoals = async (db, gateway, token, now) =>
  cached(db, cacheKey('goals', 'all'), GOALS_TTL_MS, now, async () => {
    const response = await gateway.goals({ token, counterId: METRICA_COUNTER_ID })
    if (!response.ok) return { ok: false, error: response.error }

    const wanted = new Set(Object.values(METRICA_GOALS))
    const found = {}
    for (const goal of response.data?.goals || []) {
      if (wanted.has(goal?.name)) found[goal.name] = goal.id
    }
    return { ok: true, value: found }
  })

/**
 * Сводка периода: трафик, поведение и достижения известных целей.
 *
 * Метрики целей подставляются в строку запроса шаблоном ym:s:goal<id>reaches —
 * именно так их принимает Stat API.
 */
const loadSummary = async (db, gateway, token, period, goals, now) =>
  cached(db, cacheKey('summary', period), SUMMARY_TTL_MS, now, async () => {
    const goalMetrics = Object.values(goals || {}).flatMap((id) => [
      `ym:s:goal${id}reaches`,
      `ym:s:goal${id}conversionRate`,
    ])

    const response = await gateway.stat({
      token,
      counterId: METRICA_COUNTER_ID,
      metrics: [
        'ym:s:visits',
        'ym:s:users',
        'ym:s:bounceRate',
        'ym:s:avgVisitDurationSeconds',
        ...goalMetrics,
      ].join(','),
      date1: PERIODS[period].date1,
      date2: DATE2,
    })
    if (!response.ok) return { ok: false, error: response.error }

    const totals = response.data?.totals || []
    const value = {
      visits: num(totals[0]),
      users: num(totals[1]),
      bounceRate: num(totals[2]),
      avgVisitSeconds: num(totals[3]),
      goals: {},
      sampled: Boolean(response.data?.sampled),
    }

    // Метрики целей идут парами в том же порядке, в каком собирались.
    Object.keys(goals || {}).forEach((name, index) => {
      value.goals[name] = {
        reaches: num(totals[4 + index * 2]),
        conversionRate: num(totals[5 + index * 2]),
      }
    })
    return { ok: true, value }
  })

/** Источники трафика по последнему значимому переходу. */
const loadSources = async (db, gateway, token, period, now) =>
  cached(db, cacheKey('sources', period), SUMMARY_TTL_MS, now, async () => {
    const response = await gateway.stat({
      token,
      counterId: METRICA_COUNTER_ID,
      metrics: 'ym:s:visits',
      dimensions: 'ym:s:lastsignTrafficSource',
      // lastsign — «последний значимый переход»: он не приписывает заявку
      // прямому заходу, если человек вернулся на сайт по закладке.
      attribution: 'lastsign',
      sort: '-ym:s:visits',
      date1: PERIODS[period].date1,
      date2: DATE2,
      limit: 10,
    })
    if (!response.ok) return { ok: false, error: response.error }

    const rows = (response.data?.data || []).map((row) => ({
      name: row?.dimensions?.[0]?.name || 'не определён',
      visits: num(row?.metrics?.[0]),
    }))
    return { ok: true, value: rows }
  })

/**
 * Заявки из СВОЕЙ базы за тот же период.
 *
 * Это не дубль метрики целей, а сверка. Расхождение в разы означает, что
 * цель отваливается: блокировщик режет счётчик, цель переименовали, вызов
 * потерялся при рефакторинге формы. Без этой цифры такое расхождение
 * замечают через квартал, по отчёту, который «что-то не сходится».
 */
const countLeads = (db, days, now) =>
  Number(
    db.get('SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?', [
      now - days * 24 * 60 * 60 * 1000,
    ])?.n
  ) || 0

/**
 * Собирает сводку для экрана «Аналитика».
 *
 * Токен принимается параметром, а не читается здесь: решение, откуда он
 * берётся (настройка или окружение), принадлежит маршруту, а этому модулю
 * незачем знать про реестр настроек.
 */
export const buildAnalyticsDashboard = async ({
  db,
  gateway,
  token,
  period = DEFAULT_PERIOD,
  now = Date.now(),
}) => {
  if (!db || !gateway) throw new TypeError('analytics dashboard requires db and gateway')

  const key = Object.prototype.hasOwnProperty.call(PERIODS, period) ? period : DEFAULT_PERIOD
  const result = {
    period: key,
    periodTitle: PERIODS[key].title,
    counterId: METRICA_COUNTER_ID,
    generatedAt: now,
    configured: Boolean(token),
    leads: countLeads(db, PERIODS[key].days, now),
  }

  // Без токена в API не ходим вовсе: экран покажет инструкцию, а не ошибку.
  if (!token) return { ...result, error: 'not_configured' }

  const goals = await loadGoals(db, gateway, token, now)
  const [summary, sources] = await Promise.all([
    loadSummary(db, gateway, token, key, goals.value || {}, now),
    loadSources(db, gateway, token, key, now),
  ])

  // Ошибка показывается первая непустая: она у всех трёх запросов одна и та же
  // в подавляющем большинстве случаев (протухший токен, сеть, квота).
  const error = summary.error || sources.error || goals.error || null

  return {
    ...result,
    error,
    // stale важнее error: цифры на экране есть, но они не сегодняшние,
    // и оператор обязан это видеть, прежде чем принимать по ним решения.
    stale: Boolean(summary.stale || sources.stale),
    fetchedAt: summary.fetchedAt ?? null,
    summary: summary.value,
    sources: sources.value || [],
    knownGoals: goals.value || {},
    // Какие из объявленных целей вообще заведены в счётчике. Пустой список —
    // это не ошибка API, а незаконченная настройка, и лечится она в Метрике.
    missingGoals: Object.values(METRICA_GOALS).filter((name) => !(goals.value || {})[name]),
  }
}
