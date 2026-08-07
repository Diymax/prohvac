import { useCallback, useEffect, useState } from 'react'

import { api } from '../api.js'
import Notice from '../components/Notice.jsx'
import { errorText, formatBytes, formatDateTime } from '../components/format.js'

const WARNING_TEXT = {
  telegram_not_configured: 'Telegram не готов принимать заявки',
  translation_jobs_failed: 'Есть задания перевода с ошибками',
  media_quota_high: 'Медиахранилище заполнено более чем на 90%',
  security_activity: 'За последние сутки обнаружена блокируемая активность',
}

const Metric = ({ label, value, href }) => (
  <article className="adm-card adm-overview__metric">
    <span className="adm-overview__label">{label}</span>
    <strong className="adm-overview__value">{value}</strong>
    {href ? <a href={href}>Открыть раздел</a> : null}
  </article>
)

const Overview = ({ session }) => {
  const [dashboard, setDashboard] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.get('/overview')
      setDashboard(response.dashboard)
    } catch (nextError) {
      setError(nextError)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <section className="adm-panel" aria-busy={loading}>
      <header className="adm-panel__head">
        <div>
          <h1 className="adm-panel__title">Обзор</h1>
          <p className="adm-panel__hint">
            Состояние заявок, интеграций и фоновых задач без раскрытия секретов.
          </p>
        </div>
        <button className="adm-button adm-button--secondary" type="button" onClick={load} disabled={loading}>
          {loading ? 'Обновление…' : 'Обновить'}
        </button>
      </header>

      {error ? <Notice kind="error">{errorText(error)}</Notice> : null}
      {loading && !dashboard ? <p className="adm-text" role="status">Загрузка показателей…</p> : null}

      {dashboard ? (
        <>
          {dashboard.warnings?.length ? (
            <div className="adm-overview__warnings" aria-label="Предупреждения">
              {dashboard.warnings.map((warning) => (
                <Notice key={warning.code} kind="warning">
                  {WARNING_TEXT[warning.code] || warning.code}.{' '}
                  <a href={`#/${warning.section}`}>Перейти</a>
                </Notice>
              ))}
            </div>
          ) : (
            <Notice kind="success">Активных operational-предупреждений нет.</Notice>
          )}

          <div className="adm-overview__grid">
            {dashboard.leads ? (
              <>
                <Metric label="Новые заявки" value={dashboard.leads.new} href="#/leads?status=new" />
                {/* Это СЧЁТЧИКИ заявок, а не состояние бота: прежние подписи
                    «Telegram: failed» и «Delivery unknown» читались как статус
                    интеграции, и ноль рядом со словом failed выглядел поломкой.
                    Само состояние бота — отдельная плитка «Telegram» ниже. */}
                <Metric label="Не доставлено в Telegram" value={dashboard.leads.failed} href="#/leads?undelivered=1" />
                <Metric label="Доставка под вопросом" value={dashboard.leads.deliveryUnknown} href="#/leads?undelivered=1" />
              </>
            ) : null}
            {dashboard.translations ? (
              <>
                <Metric label="Переводы в очереди" value={dashboard.translations.queued + dashboard.translations.deferred} href="#/content" />
                <Metric label="Ошибки переводов" value={dashboard.translations.failed} href="#/content" />
                <Metric label="Последний перевод" value={formatDateTime(dashboard.translations.lastSuccessAt) || '—'} href="#/content" />
              </>
            ) : null}
            {dashboard.media ? (
              <Metric
                label="Медиахранилище"
                value={`${formatBytes(dashboard.media.usedBytes)} / ${formatBytes(dashboard.media.quotaBytes)}`}
                href="#/media"
              />
            ) : null}
            {dashboard.telegram ? (
              <Metric label="Telegram" value={dashboard.telegram.ready ? 'готов' : 'не настроен'} href={session.capabilities?.['settings.manage'] ? '#/settings' : '#/leads'} />
            ) : null}
            {dashboard.security ? (
              <>
                <Metric label="Отказы за 24 часа" value={dashboard.security.deniedActions24h} href="#/security" />
                <Metric label="Активные IP-блокировки" value={dashboard.security.activeIpBlocks} href="#/security" />
              </>
            ) : null}
            {dashboard.disk ? (
              <Metric label="Свободно на диске" value={formatBytes(dashboard.disk.freeBytes)} />
            ) : null}
          </div>

          <p className="adm-panel__hint">
            Пользователь: {session.user?.username || '—'} · роль: {session.user?.role || '—'} ·
            обновлено {formatDateTime(dashboard.generatedAt)}
          </p>
        </>
      ) : null}
    </section>
  )
}

export default Overview
