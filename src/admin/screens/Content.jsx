// Экран правки текстов сайта.
//
// СЛЕВА ИСХОДНИК, СПРАВА ПЕРЕВОДЫ. Русский текст — единственный источник:
// именно с него делается автоперевод, и его правка помечает остальные языки
// устаревшими. Поэтому ru стоит отдельной колонкой, а не пятым равноправным
// полем: редактор должен видеть, что он меняет причину, а не одно из следствий.
//
// СТРОКИ СВЁРНУТЫ ПО УМОЛЧАНИЮ. Ключей на лендинге несколько сотен, и пять
// textarea на каждый — это тысячи узлов DOM, которые браузер честно раскладывает
// при каждом нажатии клавиши. В свёрнутом виде строка показывает ключ, начало
// русского текста и четыре метки статуса — этого хватает, чтобы найти нужное.
//
// ПОСЛЕ СОХРАНЕНИЯ СПИСОК ПЕРЕЧИТЫВАЕТСЯ ЦЕЛИКОМ. Статусы переводов сервер
// вычисляет из хешей (см. шапку server/routes/admin.content.js), а не хранит,
// поэтому единственный способ показать их верно после правки — спросить
// сервер заново. Досчитывать статусы на клиенте значило бы завести вторую
// реализацию тех же правил, которая рано или поздно разойдётся с первой.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'
import Notice from '../components/Notice.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { errorText, formatDateTime } from '../components/format.js'

const SOURCE = 'ru'
const TARGETS = ['en', 'uz', 'tr', 'ar']
const LOCALES = [SOURCE, ...TARGETS]

const LANG_NAMES = {
  ru: 'Русский',
  en: 'Английский',
  uz: 'Узбекский',
  tr: 'Турецкий',
  ar: 'Арабский',
}

// Порядок разделов повторяет порядок блоков на странице: редактор ищет текст
// глазами по странице, а не по алфавиту. Разделы, которых здесь нет (например,
// заведённые вместе с новым проектом), дописываются следом по алфавиту.
const SECTION_ORDER = [
  'nav',
  'hero',
  'services',
  'ratings',
  'projects',
  'about',
  'form',
  'formsent',
  'footer',
]

const SECTION_NAMES = {
  nav: 'Меню',
  hero: 'Первый экран',
  services: 'Услуги и преимущества',
  ratings: 'Цифры',
  projects: 'Проекты',
  about: 'О компании',
  form: 'Форма заявки',
  formsent: 'После отправки',
  footer: 'Подвал',
}

// Как часто перечитывается состояние очереди перевода, пока в ней что-то есть.
// Реже — и «выполняется» висит на экране после того, как всё закончилось;
// чаще — и админка стучится в сервер без повода.
const STATUS_POLL_MS = 15_000

const sectionLabel = (name) => SECTION_NAMES[name] ?? name

/** Высота поля под объём текста: заголовок не должен занимать восемь строк. */
const rowsFor = (value) => Math.min(10, Math.max(2, Math.ceil((value.length || 1) / 70) + 1))

/**
 * Сводка сохранения. Ровно то, что нужно редактору: сколько языков ушло
 * в автоперевод и сколько осталось на нём самом, потому что перетирать
 * выверенный руками перевод сервер отказывается (см. шапку admin.content.js).
 */
const summaryText = (queued, stale) => {
  const parts = [`поставлено в очередь ${queued.length}`]
  if (queued.length) parts[0] += ` (${queued.join(', ')})`
  parts.push(`устарело ${stale.length}`)
  if (stale.length) parts[1] += ` (${stale.join(', ')})`
  return `Сохранено: ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------
// Поле одного языка
// ---------------------------------------------------------------------------

const LangField = ({ lang, value, status, dirty, disabled, onChange }) => (
  <label className={`adm-field adm-field--lang${dirty ? ' adm-field--dirty' : ''}`}>
    <span className="adm-field__head">
      <span className="adm-label">
        {LANG_NAMES[lang]} <span className="adm-muted">({lang})</span>
      </span>
      {status ? <StatusBadge status={status} /> : null}
    </span>
    <textarea
      className="adm-textarea"
      value={value}
      rows={rowsFor(value)}
      // Арабский пишется справа налево: без dir курсор и знаки препинания
      // прыгают, и выверить текст в поле невозможно.
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      disabled={disabled}
      onChange={(event) => onChange(lang, event.target.value)}
    />
  </label>
)

// ---------------------------------------------------------------------------
// Строка ключа
// ---------------------------------------------------------------------------

const KeyRow = ({
  row,
  draft,
  expanded,
  saving,
  notice,
  onToggle,
  onChange,
  onSave,
  onReset,
  onTranslate,
  canWrite,
}) => {
  const valueOf = (lang) => draft?.[lang] ?? row.values?.[lang] ?? ''
  const dirtyLangs = LOCALES.filter(
    (lang) => draft?.[lang] !== undefined && draft[lang] !== (row.values?.[lang] ?? '')
  )
  const dirty = dirtyLangs.length > 0

  return (
    <article className={`adm-card adm-key${dirty ? ' adm-key--dirty' : ''}`}>
      <header className="adm-key__head">
        <button
          type="button"
          className="adm-key__toggle"
          onClick={() => onToggle(row.key)}
          aria-expanded={expanded}
        >
          <span className="adm-key__name">{row.key}</span>
          {!expanded && (
            <span className="adm-key__preview">{valueOf(SOURCE) || '— текста нет —'}</span>
          )}
        </button>

        <span className="adm-key__statuses">
          {TARGETS.map((lang) => (
            <StatusBadge
              key={lang}
              status={row.status?.[lang] ?? 'missing'}
              label={`${lang}: ${row.status?.[lang] ?? 'missing'}`}
            />
          ))}
        </span>
      </header>

      {expanded && (
        <div className="adm-key__body">
          <div className="adm-key__source">
            <LangField
              lang={SOURCE}
              value={valueOf(SOURCE)}
              status={row.status?.[SOURCE]}
              dirty={dirtyLangs.includes(SOURCE)}
              disabled={saving || !canWrite}
              onChange={(lang, value) => onChange(row.key, lang, value)}
            />
          </div>

          <div className="adm-key__targets">
            {TARGETS.map((lang) => (
              <LangField
                key={lang}
                lang={lang}
                value={valueOf(lang)}
                status={row.status?.[lang]}
                dirty={dirtyLangs.includes(lang)}
                disabled={saving || !canWrite}
                onChange={(langCode, value) => onChange(row.key, langCode, value)}
              />
            ))}
          </div>

          <footer className="adm-key__foot">
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              disabled={!canWrite || !dirty || saving}
              onClick={() => onSave(row)}
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
            <button
              type="button"
              className="adm-btn adm-btn--ghost"
              disabled={!canWrite || !dirty || saving}
              onClick={() => onReset(row.key)}
            >
              Отменить правки
            </button>
            <button
              type="button"
              className="adm-btn"
              disabled={!canWrite || saving}
              onClick={() => onTranslate([row.key])}
              title="Поставить этот ключ в очередь автоперевода"
            >
              Перевести
            </button>
            <span className="adm-muted adm-key__meta">
              раздел {sectionLabel(row.section)} · изменён {formatDateTime(row.updatedAt)}
            </span>
          </footer>

          {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

const Content = ({ session }) => {
  const canWrite = session.capabilities?.['content.write'] === true
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [section, setSection] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  const [drafts, setDrafts] = useState({})
  const [savingKey, setSavingKey] = useState('')
  const [notices, setNotices] = useState({})

  const [force, setForce] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNotice, setBulkNotice] = useState(null)

  const [queue, setQueue] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get('/api/admin/content')
      if (data?.ok === false) throw data
      setRows(Array.isArray(data?.keys) ? data.keys : [])
      setLoadError('')
    } catch (error) {
      setLoadError(errorText(error, 'Не удалось загрузить тексты'))
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * Состояние очереди автоперевода. Ошибку глотаем молча и в состояние не
   * пишем: воркер переводов — отдельная подсистема, и её недоступность не
   * повод закрывать редактору доступ к текстам.
   */
  const loadQueue = useCallback(async () => {
    try {
      const data = await api.get('/api/admin/translate/status')
      if (data?.ok === false) return
      setQueue(data ?? null)
    } catch {
      setQueue(null)
    }
  }, [])

  useEffect(() => {
    load()
    loadQueue()
  }, [load, loadQueue])

  // Пока в очереди что-то есть, состояние обновляется само: иначе редактор
  // сидит на странице и гадает, перевелось ли уже.
  useEffect(() => {
    const active = (queue?.queued ?? 0) + (queue?.running ?? 0)
    if (!active) return undefined

    const timer = setInterval(loadQueue, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [queue, loadQueue])

  const sections = useMemo(() => {
    const counts = new Map()
    for (const row of rows) counts.set(row.section, (counts.get(row.section) ?? 0) + 1)

    const known = SECTION_ORDER.filter((name) => counts.has(name))
    const rest = [...counts.keys()].filter((name) => !SECTION_ORDER.includes(name)).sort()
    return [...known, ...rest].map((name) => ({ name, count: counts.get(name) }))
  }, [rows])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (section && row.section !== section) return false
      if (!needle) return true
      // Ищем и по ключу, и по русскому тексту: половина правок начинается
      // с фразы, увиденной на сайте, а не с имени ключа.
      return (
        row.key.toLowerCase().includes(needle) ||
        String(row.values?.[SOURCE] ?? '').toLowerCase().includes(needle)
      )
    })
  }, [rows, section, search])

  const setNotice = (key, kind, text) =>
    setNotices((current) => ({ ...current, [key]: { kind, text } }))

  const toggle = (key) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const change = (key, lang, value) =>
    setDrafts((current) => ({ ...current, [key]: { ...current[key], [lang]: value } }))

  const reset = (key) =>
    setDrafts((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })

  const saveRow = async (row) => {
    const draft = drafts[row.key]
    if (!draft) return

    const changed = LOCALES.filter(
      (lang) => draft[lang] !== undefined && draft[lang] !== (row.values?.[lang] ?? '')
    )
    if (!changed.length) return

    // Русский сохраняем первым. Его правка пересчитывает состояние переводов
    // и ставит их в очередь; при обратном порядке только что отредактированный
    // вручную перевод успел бы уехать в автоперевод.
    const order = changed.includes(SOURCE)
      ? [SOURCE, ...changed.filter((lang) => lang !== SOURCE)]
      : changed

    setSavingKey(row.key)
    const queued = new Set()
    const stale = new Set()
    let saved = 0

    try {
      for (const lang of order) {
        const data = await api.put(`/api/admin/content/${encodeURIComponent(row.key)}`, {
          lang,
          value: draft[lang],
        })
        if (data?.ok === false) throw data

        saved += 1
        for (const item of data?.queued ?? []) queued.add(item)
        for (const item of data?.stale ?? []) stale.add(item)
      }

      reset(row.key)
      setNotice(row.key, 'ok', summaryText([...queued], [...stale]))
      await Promise.all([load(), loadQueue()])
    } catch (error) {
      // Часть языков могла сохраниться до отказа: перечитываем список, иначе
      // на экране останутся значения, которых в базе уже нет.
      setNotice(row.key, 'error', errorText(error, 'Не удалось сохранить текст'))
      if (saved) await load()
    } finally {
      setSavingKey('')
    }
  }

  const translate = async (keys) => {
    setBulkBusy(true)
    setBulkNotice(null)
    try {
      const body = { force }
      if (keys) body.keys = keys

      const data = await api.post('/api/admin/content/translate', body)
      if (data?.ok === false) throw data

      const skipped = data?.skipped ?? {}
      const detail = [
        `уже переведено: ${skipped.upToDate ?? 0}`,
        `защищено ручной правкой: ${skipped.locked ?? 0}`,
        `без исходника: ${skipped.noSource ?? 0}`,
      ].join(', ')

      setBulkNotice({
        kind: 'ok',
        text: `Поставлено в очередь: ${data?.queued ?? 0}. Пропущено — ${detail}.`,
      })
      await loadQueue()
    } catch (error) {
      setBulkNotice({ kind: 'error', text: errorText(error, 'Не удалось запустить перевод') })
    } finally {
      setBulkBusy(false)
    }
  }

  const dirtyCount = Object.keys(drafts).length

  return (
    <section className="adm-screen adm-screen--content">
      <header className="adm-screen__head">
        <h1 className="adm-screen__title">Тексты сайта</h1>
        <p className="adm-muted">
          Слева русский исходник, справа переводы. Правка русского текста делает
          переводы устаревшими: незаблокированные уходят в автоперевод, выверенные
          руками остаются на месте и ждут вашего решения.
        </p>
      </header>

      {!canWrite ? (
        <Notice kind="info">У вашей роли доступ к текстам только для чтения.</Notice>
      ) : null}

      <div className="adm-toolbar">
        <input
          type="search"
          className="adm-input"
          placeholder="Поиск по ключу или русскому тексту"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <button type="button" className="adm-btn" onClick={load} disabled={loading}>
          Обновить
        </button>

        <label className="adm-check" title="Перезаписать даже выверенные руками переводы">
          <input
            type="checkbox"
            checked={force}
            disabled={!canWrite}
            onChange={(event) => setForce(event.target.checked)}
          />
          Перезаписывать ручные переводы
        </label>

        <button
          type="button"
          className="adm-btn"
          disabled={!canWrite || bulkBusy || !visible.length}
          onClick={() => translate(visible.map((row) => row.key))}
        >
          Перевести показанные ({visible.length})
        </button>

        <button
          type="button"
          className="adm-btn"
          disabled={!canWrite || bulkBusy}
          onClick={() => translate(null)}
          title="Все ключи сайта на все языки"
        >
          Перевести всё
        </button>
      </div>

      {queue ? (
        <div className="adm-queue">
          В очереди: <strong>{queue.queued ?? 0}</strong> · выполняется:{' '}
          <strong>{queue.running ?? 0}</strong> · ошибок: <strong>{queue.failed ?? 0}</strong>
          {queue.usage ? (
            <span className="adm-muted">
              {' '}
              · провайдер {queue.usage.provider ?? '—'}: {queue.usage.used ?? 0}
              {queue.usage.limit ? ` из ${queue.usage.limit}` : ''} символов
            </span>
          ) : null}
          <button type="button" className="adm-btn adm-btn--ghost" onClick={loadQueue}>
            Обновить
          </button>
        </div>
      ) : null}

      <nav className="adm-tabs">
        <button
          type="button"
          className={`adm-tab${section === '' ? ' adm-tab--active' : ''}`}
          onClick={() => setSection('')}
        >
          Все ({rows.length})
        </button>
        {sections.map((item) => (
          <button
            key={item.name}
            type="button"
            className={`adm-tab${section === item.name ? ' adm-tab--active' : ''}`}
            onClick={() => setSection(item.name)}
          >
            {sectionLabel(item.name)} ({item.count})
          </button>
        ))}
      </nav>

      {bulkNotice ? <Notice kind={bulkNotice.kind}>{bulkNotice.text}</Notice> : null}
      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {dirtyCount > 0 ? (
        <Notice kind="info">
          Несохранённых строк: {dirtyCount}. Правки живут только в этой вкладке — до
          нажатия «Сохранить» они никуда не уйдут.
        </Notice>
      ) : null}

      {loading && !rows.length ? <p className="adm-muted">Загружаю тексты…</p> : null}
      {!loading && !visible.length ? <p className="adm-muted">Ничего не найдено.</p> : null}

      <div className="adm-keys">
        {visible.map((row) => (
          <KeyRow
            key={row.key}
            row={row}
            draft={drafts[row.key]}
            expanded={expanded.has(row.key) || Boolean(drafts[row.key])}
            saving={savingKey === row.key}
            notice={notices[row.key]}
            onToggle={toggle}
            onChange={change}
            onSave={saveRow}
            onReset={reset}
            onTranslate={translate}
            canWrite={canWrite}
          />
        ))}
      </div>
    </section>
  )
}

export default Content
