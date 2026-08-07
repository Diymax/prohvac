import { useCallback, useEffect, useState } from 'react'

import { api } from '../api.js'
import Notice from '../components/Notice.jsx'
import { errorText } from '../components/format.js'

// Тексты ошибок Яндекса. Разделены по причинам, потому что чинятся они
// в разных местах: токен — в настройках, доступ — в кабинете Метрики,
// квота — временем. Общее «не удалось получить данные» заставило бы
// оператора гадать.
const ERROR_TEXT = {
  not_configured: 'OAuth-токен Метрики не задан. Настройки → Аналитика.',
  unauthorized: 'Токен отклонён Яндексом: истёк или отозван. Замените его в настройках.',
  forbidden: 'У аккаунта токена нет доступа к счётчику. Выдайте гостевой доступ в Метрике.',
  rate_limited: 'Превышена квота запросов к API. Данные обновятся автоматически.',
  timeout: 'Яндекс не ответил вовремя.',
  network: 'Не удалось связаться с API Метрики.',
  upstream_failed: 'API Метрики отвечает ошибкой.',
  bad_request: 'API Метрики отклонило запрос.',
}

const PERIODS = [
  { id: '7d', title: '7 дней' },
  { id: '30d', title: '30 дней' },
  { id: '90d', title: '90 дней' },
]

const GOAL_TITLE = {
  form_submit: 'Заявки с формы',
  phone_click: 'Клики по телефону',
}

const int = (value) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(value) || 0))
const percent = (value) => `${(Number(value) || 0).toFixed(1)}%`

const duration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const time = (timestamp) =>
  timestamp ? new Date(timestamp).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'

const Metric = ({ label, value, hint }) => (
  <article className="adm-card adm-overview__metric">
    <span className="adm-overview__label">{label}</span>
    <strong className="adm-overview__value">{value}</strong>
    {hint ? <span className="adm-overview__label">{hint}</span> : null}
  </article>
)

const Analytics = () => {
  const [period, setPeriod] = useState('30d')
  const [dashboard, setDashboard] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (next) => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.get(`/analytics/summary?period=${encodeURIComponent(next)}`)
      setDashboard(response.dashboard)
    } catch (nextError) {
      setError(nextError)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(period)
  }, [load, period])

  const summary = dashboard?.summary
  const goals = summary?.goals || {}
  // Максимум нужен для длины полосок: рисуем доли без графической библиотеки —
  // ради одного экрана тянуть в бандл recharts несоразмерно.
  const maxVisits = Math.max(1, ...(dashboard?.sources || []).map((row) => row.visits))

  return (
    <section className="adm-panel" aria-busy={loading}>
      <header className="adm-panel__head">
        <div>
          <h1 className="adm-panel__title">Аналитика</h1>
          <p className="adm-panel__hint">
            Сводка Яндекс.Метрики{dashboard?.counterId ? ` по счётчику ${dashboard.counterId}` : ''}.
            Данные за период по вчерашний день включительно.
          </p>
        </div>
        <button
          className="adm-button adm-button--secondary"
          type="button"
          onClick={() => load(period)}
          disabled={loading}
        >
          {loading ? 'Обновление…' : 'Обновить'}
        </button>
      </header>

      <div className="adm-overview__warnings" role="group" aria-label="Период">
        {PERIODS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`adm-button ${period === item.id ? '' : 'adm-button--secondary'}`}
            onClick={() => setPeriod(item.id)}
            disabled={loading}
            aria-pressed={period === item.id}
          >
            {item.title}
          </button>
        ))}
      </div>

      {error ? <Notice kind="error">{errorText(error)}</Notice> : null}

      {dashboard?.error ? (
        <Notice kind={dashboard.error === 'not_configured' ? 'warning' : 'error'}>
          {ERROR_TEXT[dashboard.error] || dashboard.error}
        </Notice>
      ) : null}

      {/* Устаревшие цифры показываются, но помеченными: решение по ним всё
          равно принимают, и знать их возраст важнее, чем видеть пустой экран. */}
      {dashboard?.stale ? (
        <Notice kind="warning">
          Показаны последние удачно полученные данные от {time(dashboard.fetchedAt)}.
        </Notice>
      ) : null}

      {dashboard?.missingGoals?.length ? (
        <Notice kind="warning">
          В счётчике не найдены цели: {dashboard.missingGoals.join(', ')}. Заведите их
          в Метрике как «JavaScript-событие» — без них конверсия не считается.
        </Notice>
      ) : null}

      {loading && !dashboard ? (
        <p className="adm-text" role="status">
          Загрузка показателей…
        </p>
      ) : null}

      {summary ? (
        <>
          <div className="adm-overview__grid">
            <Metric label="Визиты" value={int(summary.visits)} />
            <Metric label="Посетители" value={int(summary.users)} />
            <Metric label="Отказы" value={percent(summary.bounceRate)} />
            <Metric label="Время на сайте" value={duration(summary.avgVisitSeconds)} hint="мин:сек" />
            {Object.entries(goals).map(([name, value]) => (
              <Metric
                key={name}
                label={GOAL_TITLE[name] || name}
                value={int(value.reaches)}
                hint={`конверсия ${percent(value.conversionRate)}`}
              />
            ))}
          </div>

          {/* Сверка со своей базой. Это не дубль метрики целей: расхождение
              в разы означает, что цель отваливается — блокировщик режет
              счётчик, цель переименовали, вызов потерялся при рефакторинге
              формы. Без этой цифры такое замечают через квартал. */}
          <div className="adm-card">
            <h2 className="adm-card__title">Сверка с журналом заявок</h2>
            <p className="adm-text">
              Заявок в базе за период: <strong>{int(dashboard.leads)}</strong>. Достижений цели
              «{GOAL_TITLE.form_submit}» в Метрике: <strong>{int(goals.form_submit?.reaches)}</strong>.
            </p>
            <p className="adm-panel__hint">
              Метрика всегда считает меньше: часть посетителей режет счётчик блокировщиком.
              Тревожно, если цель показывает около нуля при непустом журнале — значит, цель
              не срабатывает.
            </p>
          </div>
        </>
      ) : null}

      {dashboard?.sources?.length ? (
        <div className="adm-card">
          <h2 className="adm-card__title">Источники трафика</h2>
          {/* Список, а не <table>: в админке нет табличных стилей, а свои
              ради одного экрана заводить незачем — полоска показывает долю
              нагляднее выровненных колонок. */}
          <ul className="adm-list">
            {dashboard.sources.map((row) => (
              <li key={row.name}>
                <div className="adm-row">
                  <span>{row.name}</span>
                  <strong>{int(row.visits)}</strong>
                </div>
                <span
                  className="adm-quota__bar"
                  style={{ width: `${Math.round((row.visits / maxVisits) * 100)}%` }}
                  aria-hidden="true"
                />
                <span className="adm-overview__label">
                  {percent((row.visits / Math.max(1, summary?.visits || maxVisits)) * 100)} визитов
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary?.sampled ? (
        <Notice kind="warning">
          Яндекс вернул данные по выборке — точность снижена. Уменьшите период.
        </Notice>
      ) : null}
    </section>
  )
}

export default Analytics
