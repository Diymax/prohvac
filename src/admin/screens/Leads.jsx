// Журнал заявок с формы.
//
// ЗДЕСЬ ПЕРСОНАЛЬНЫЕ ДАННЫЕ. Отсюда несколько решений экрана:
//   - выгрузка CSV — обычная ссылка, а не кнопка с fetch: файл с ПДн должен
//     скачиваться браузером напрямую, не превращаясь по дороге в строку
//     в памяти вкладки и в объект URL, который потом кто-то забудет отозвать.
//     Каждое такое скачивание сервер пишет в audit_log;
//   - срок хранения виден в карточке: заявка исчезнет сама, и менеджер должен
//     понимать, что «потом посмотрю» имеет предел.
//
// ПОВТОРНАЯ ОТПРАВКА нужна потому, что заявка пишется в базу ДО обращения
// к Telegram: если бот был недоступен, клиент уже увидел «спасибо», а
// сообщение в чат не ушло.
//
// Кнопка есть у КАЖДОЙ заявки, а не только у недоставленной: карточку в чате
// теряют и по причинам, которых сервер не видит — сообщение удалили, чат
// почистили, менеджер потерял его в потоке. Раньше в таком случае оставалось
// просить клиента отправить форму заново. Цена решения — риск дубля в чате,
// поэтому у уже доставленной заявки повтор идёт через подтверждение и флаг
// force, а не одним кликом.
//
// ФИЛЬТРЫ ПРИМЕНЯЮТСЯ ПО КНОПКЕ, а не при каждом нажатии клавиши: список
// заявок — это запрос к базе с подсчётом общего числа строк, и дёргать его
// на каждую букву в поле телефона незачем.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'
import ConfirmButton from '../components/ConfirmButton.jsx'
import Notice from '../components/Notice.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { errorCode, errorText, formatDateTime } from '../components/format.js'

const STATUS_OPTIONS = [
  ['all', 'все статусы'],
  ['new', 'новые'],
  ['in_progress', 'в работе'],
  ['done', 'обработанные'],
  ['spam', 'спам'],
]

// Значения совпадают с CHECK таблицы leads: список в селекте карточки.
const LEAD_STATUSES = [
  ['new', 'новая'],
  ['in_progress', 'в работе'],
  ['done', 'обработана'],
  ['spam', 'спам'],
]

const LIMITS = [25, 50, 100, 200]

const EMPTY_FILTERS = {
  status: 'all',
  from: '',
  to: '',
  phone: '',
  undelivered: false,
  limit: 50,
}

/**
 * Строка запроса для списка и для выгрузки — одна и та же: файл обязан
 * содержать ровно то, что человек видит на экране, иначе «скачал не то»
 * выясняется уже в переписке с бухгалтерией.
 */
const buildQuery = (filters, offset) => {
  const params = new URLSearchParams()

  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)

  const phone = filters.phone.trim()
  if (phone) params.set('phone', phone)
  if (filters.undelivered) params.set('telegram', 'undelivered')

  params.set('limit', String(filters.limit))
  if (offset) params.set('offset', String(offset))

  return params.toString()
}

// ---------------------------------------------------------------------------
// Карточка заявки
// ---------------------------------------------------------------------------

const LeadCard = ({
  lead,
  note,
  busy,
  notice,
  canWrite,
  canRetry,
  onNote,
  onSaveNote,
  onStatus,
  onResend,
}) => {
  // Три ветки повтора вместо одной кнопки: они отличаются не видом, а тем,
  // какое подтверждение сервер требует от оператора (см. claimRetry).
  const unknown = lead.telegramStatus === 'delivery_unknown'
  const delivered = lead.telegramStatus === 'sent'
  const inFlight = lead.telegramStatus === 'sending' || lead.telegramStatus === 'pending'

  return (
    <li className="adm-card adm-lead">
      <header className="adm-lead__head">
        <span className="adm-lead__date">{formatDateTime(lead.createdAt)}</span>
        <strong className="adm-lead__name">{lead.name}</strong>
        {/* tel:-ссылка: менеджер работает с телефона и звонит прямо отсюда. */}
        <a className="adm-lead__phone" href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`}>
          {lead.phone}
        </a>
        <StatusBadge status={lead.status} />
        <StatusBadge status={lead.telegramStatus} />
      </header>

      {lead.message ? <p className="adm-lead__message">{lead.message}</p> : null}

      <div className="adm-muted adm-lead__meta">
        №{lead.id} · язык {lead.locale}
        {lead.pagePath ? ` · страница ${lead.pagePath}` : ''}
        {/* Статус можно поменять и кнопкой в чате, поэтому «кто поставил»
            приходится показывать явно: иначе менеджер видит «в работе»
            и не знает, его это отметка или коллеги из Telegram. */}
        {lead.statusSource
          ? ` · статус ${lead.statusSource === 'telegram' ? 'из Telegram' : 'из панели'}` +
            `${lead.statusActor ? ` (${lead.statusActor})` : ''}` +
            `${lead.statusChangedAt ? `, ${formatDateTime(lead.statusChangedAt)}` : ''}`
          : ''}
        {lead.handledBy ? ` · последним правил ${lead.handledBy}` : ''}
        {lead.telegramError ? ` · Telegram: ${lead.telegramError}` : ''}
        {lead.purgeAfter ? ` · хранится до ${formatDateTime(lead.purgeAfter)}` : ''}
      </div>

      <div className="adm-lead__controls">
        <label className="adm-field adm-field--inline">
          <span className="adm-label">Статус</span>
          <select
            className="adm-select"
            value={lead.status}
            disabled={busy || !canWrite}
            onChange={(event) => onStatus(lead, event.target.value)}
          >
            {LEAD_STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {canRetry && unknown ? (
          <ConfirmButton
            disabled={busy}
            className="adm-btn"
            confirmLabel="Точно отправить повторно"
            onConfirm={() => onResend(lead, { confirmUnknown: true })}
          >
            Проверил чат — отправить повторно
          </ConfirmButton>
        ) : null}
        {canRetry && delivered ? (
          // Подтверждение обязательно: заявка уже в чате, и повтор создаст
          // вторую карточку. Флаг force снимает защиту claimRetry от дубля.
          <ConfirmButton
            disabled={busy}
            className="adm-btn"
            confirmLabel="Да, отправить ещё раз"
            onConfirm={() => onResend(lead, { force: true })}
          >
            Отправить в Telegram ещё раз
          </ConfirmButton>
        ) : null}
        {canRetry && !unknown && !delivered ? (
          <button
            type="button"
            className="adm-btn"
            disabled={busy || inFlight}
            onClick={() => onResend(lead)}
            title={
              inFlight
                ? 'Заявка сейчас отправляется — дождитесь результата'
                : 'Отправить это сообщение в Telegram ещё раз'
            }
          >
            Дослать в Telegram
          </button>
        ) : null}
      </div>

      <label className="adm-field">
        <span className="adm-label">Заметка</span>
        <textarea
          className="adm-textarea"
          rows={2}
          value={note}
          disabled={busy || !canWrite}
          placeholder="что решили по заявке"
          onChange={(event) => onNote(lead.id, event.target.value)}
        />
      </label>

      {canWrite ? <div className="adm-lead__actions">
        <button
          type="button"
          className="adm-btn adm-btn--primary"
          disabled={busy || note === (lead.note ?? '')}
          onClick={() => onSaveNote(lead)}
        >
          Сохранить заметку
        </button>
        {note !== (lead.note ?? '') ? (
          <button
            type="button"
            className="adm-btn adm-btn--ghost"
            disabled={busy}
            onClick={() => onNote(lead.id, lead.note ?? '')}
          >
            Отменить
          </button>
        ) : null}
      </div> : null}

      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

const Leads = ({ session }) => {
  const canWrite = session.capabilities?.['leads.write'] === true
  const canRetry = session.capabilities?.['leads.retry'] === true
  const canExport = session.capabilities?.['leads.export'] === true
  const [form, setForm] = useState(EMPTY_FILTERS)
  const [applied, setApplied] = useState(EMPTY_FILTERS)
  const [offset, setOffset] = useState(0)

  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [notes, setNotes] = useState({})
  const [busyId, setBusyId] = useState(0)
  const [notices, setNotices] = useState({})

  const query = useMemo(() => buildQuery(applied, offset), [applied, offset])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get(`/api/admin/leads?${query}`)
      if (data?.ok === false) throw data

      const list = Array.isArray(data?.items) ? data.items : []
      setItems(list)
      setTotal(data?.total ?? list.length)
      // Заметки держим отдельным черновиком: пока менеджер печатает, список
      // может перечитаться, и правка не должна пропасть при обновлении.
      setNotes((current) => {
        const next = { ...current }
        for (const lead of list) if (next[lead.id] === undefined) next[lead.id] = lead.note ?? ''
        return next
      })
      setLoadError('')
    } catch (error) {
      setLoadError(errorText(error, 'Не удалось загрузить заявки'))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    load()
  }, [load])

  const setNotice = (id, kind, text) =>
    setNotices((current) => ({ ...current, [id]: { kind, text } }))

  /** Заменяет одну заявку в списке ответом сервера. */
  const replaceLead = (lead) =>
    setItems((current) => current.map((item) => (item.id === lead.id ? lead : item)))

  const patch = async (lead, payload, success) => {
    setBusyId(lead.id)
    try {
      const data = await api.patch(`/api/admin/leads/${lead.id}`, payload)
      if (data?.ok === false) throw data
      if (data?.lead) {
        replaceLead(data.lead)
        setNotes((current) => ({ ...current, [lead.id]: data.lead.note ?? '' }))
      }
      setNotice(lead.id, 'ok', success)
    } catch (error) {
      setNotice(lead.id, 'error', errorText(error, 'Не удалось сохранить изменения'))
    } finally {
      setBusyId(0)
    }
  }

  const resend = async (lead, { confirmUnknown = false, force = false } = {}) => {
    setBusyId(lead.id)
    try {
      const data = await api.post(`/api/admin/leads/${lead.id}/resend`, {
        confirmUnknown,
        force,
      })
      if (data?.ok === false) throw data

      replaceLead({ ...lead, telegramStatus: 'sent', telegramError: null })
      setNotice(lead.id, 'ok', 'Сообщение ушло в Telegram.')
    } catch (error) {
      const code = errorCode(error)
      const retry = error?.retryAfterSec ?? error?.data?.retryAfterSec
      const specific =
        code === 'delivery_unknown'
          ? 'Результат доставки неизвестен. Проверьте Telegram — автоматически повторять нельзя.'
          : code === 'delivery_in_progress'
            ? 'Эта заявка уже отправляется. Дождитесь обновления статуса.'
            : code === 'delivery_unknown_requires_confirmation'
              ? 'Сначала проверьте чат и явно подтвердите повторную отправку.'
              : code === 'already_sent'
                ? 'Заявка уже доставлена. Повтор возможен только с подтверждением.'
                : code === 'telegram_disabled'
                  ? 'Отправка в Telegram выключена в настройках.'
                  : code === 'not_configured'
                    ? 'Бот не настроен: проверьте токен и chat_id в настройках.'
                    : ''
      setNotice(
        lead.id,
        'error',
        specific ||
          (code === 'rate_limited' && retry
          ? `Слишком часто — повторите через ${retry} с.`
          : errorText(error, 'Отправить не удалось'))
      )
    } finally {
      setBusyId(0)
    }
  }

  const apply = (event) => {
    event.preventDefault()
    setOffset(0)
    setApplied(form)
  }

  const reset = () => {
    setForm(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setOffset(0)
  }

  const set = (name, value) => setForm((current) => ({ ...current, [name]: value }))

  const page = Math.floor(offset / applied.limit) + 1
  const pages = Math.max(1, Math.ceil(total / applied.limit))

  return (
    <section className="adm-screen adm-screen--leads">
      <header className="adm-screen__head">
        <h1 className="adm-screen__title">Заявки</h1>
        <p className="adm-muted">
          Здесь персональные данные клиентов. Каждая выгрузка CSV попадает
          в журнал действий, а сами заявки удаляются автоматически по истечении
          срока хранения.
        </p>
      </header>

      {!canWrite ? (
        <Notice kind="info">У вашей роли заявки доступны только для чтения.</Notice>
      ) : null}

      <form className="adm-filters" onSubmit={apply}>
        <label className="adm-field adm-field--inline">
          <span className="adm-label">Статус</span>
          <select
            className="adm-select"
            value={form.status}
            onChange={(event) => set('status', event.target.value)}
          >
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="adm-field adm-field--inline">
          <span className="adm-label">С даты</span>
          <input
            type="date"
            className="adm-input"
            value={form.from}
            onChange={(event) => set('from', event.target.value)}
          />
        </label>

        <label className="adm-field adm-field--inline">
          <span className="adm-label">По дату</span>
          <input
            type="date"
            className="adm-input"
            value={form.to}
            onChange={(event) => set('to', event.target.value)}
          />
        </label>

        <label className="adm-field adm-field--inline">
          <span className="adm-label">Телефон</span>
          <input
            type="search"
            className="adm-input"
            placeholder="любой кусок номера"
            value={form.phone}
            onChange={(event) => set('phone', event.target.value)}
          />
        </label>

        <label className="adm-check">
          <input
            type="checkbox"
            checked={form.undelivered}
            onChange={(event) => set('undelivered', event.target.checked)}
          />
          Только недоставленные
        </label>

        <label className="adm-field adm-field--inline">
          <span className="adm-label">На странице</span>
          <select
            className="adm-select"
            value={String(form.limit)}
            onChange={(event) => set('limit', Number(event.target.value))}
          >
            {LIMITS.map((value) => (
              <option key={value} value={String(value)}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <div className="adm-filters__actions">
          <button type="submit" className="adm-btn adm-btn--primary">
            Показать
          </button>
          <button type="button" className="adm-btn adm-btn--ghost" onClick={reset}>
            Сбросить
          </button>
          <button type="button" className="adm-btn" onClick={load} disabled={loading}>
            Обновить
          </button>
          {canExport ? (
            <a className="adm-btn" href={`/api/admin/leads.csv?${query}`} download>
              Скачать CSV
            </a>
          ) : null}
        </div>
      </form>

      {loadError ? <Notice kind="error">{loadError}</Notice> : null}

      <div className="adm-toolbar">
        <span className="adm-muted">
          Найдено: {total} · страница {page} из {pages}
        </span>
        <button
          type="button"
          className="adm-btn"
          disabled={offset <= 0 || loading}
          onClick={() => setOffset(Math.max(0, offset - applied.limit))}
        >
          Назад
        </button>
        <button
          type="button"
          className="adm-btn"
          disabled={offset + applied.limit >= total || loading}
          onClick={() => setOffset(offset + applied.limit)}
        >
          Вперёд
        </button>
      </div>

      {loading && !items.length ? <p className="adm-muted">Загружаю заявки…</p> : null}
      {!loading && !items.length ? <p className="adm-muted">Под фильтр ничего не подошло.</p> : null}

      <ul className="adm-leads">
        {items.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            note={notes[lead.id] ?? ''}
            busy={busyId === lead.id}
            notice={notices[lead.id]}
            canWrite={canWrite}
            canRetry={canRetry}
            onNote={(id, value) => setNotes((current) => ({ ...current, [id]: value }))}
            onSaveNote={(item) =>
              patch(item, { note: notes[item.id] ?? '' }, 'Заметка сохранена.')
            }
            onStatus={(item, status) => patch(item, { status }, 'Статус изменён.')}
            onResend={resend}
          />
        ))}
      </ul>
    </section>
  )
}

export default Leads
