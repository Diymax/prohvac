// Экран структурных блоков лендинга: проекты, партнёры, преимущества, цифры
// и телефоны.
//
// ОДНО ОПИСАНИЕ ТИПА НА ВСЁ. Пять сущностей отличаются набором полей, а не
// поведением: список, форма, порядок и удаление у них одинаковые. Поэтому
// здесь один универсальный список и одна универсальная форма, а различия
// вынесены в TYPES. Пять почти одинаковых компонентов означали бы, что
// исправление в одном из них забудут в четырёх остальных.
//
// ПОРЯДОК — КНОПКАМИ, А НЕ ПЕРЕТАСКИВАНИЕМ. Причина в components/OrderButtons.jsx.
// На сервер уходит ВЕСЬ порядок целиком (POST .../reorder {ids}), потому что
// сервер переписывает позиции списком: частичный список оставил бы одинаковые
// позиции у разных строк.
//
// SLUG И КЛЮЧ ЦИФРЫ НЕИЗМЕНЯЕМЫ. По ним адресуются ключи текстов
// (projects.<slug>.title и далее), и переименование оторвало бы от записи все
// пять языков. Поэтому эти поля есть только в форме создания — так же, как на
// сервере (см. updateEntity в server/routes/admin.content.js).
//
// СЕРВЕР ВОЗВРАЩАЕТ ВЕСЬ НАБОР СУЩНОСТЕЙ ПОСЛЕ КАЖДОЙ МУТАЦИИ, и мы им
// пользуемся: перерисовывать список из ответа дешевле и честнее, чем чинить
// локальную копию руками и надеяться, что она сойдётся с базой.

import { useCallback, useEffect, useState } from 'react'

import { api } from '../api.js'
import ConfirmButton from '../components/ConfirmButton.jsx'
import MediaPicker from '../components/MediaPicker.jsx'
import Notice from '../components/Notice.jsx'
import OrderButtons from '../components/OrderButtons.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { errorText } from '../components/format.js'

const STATUS_OPTIONS = [
  ['published', 'на сайте'],
  ['hidden', 'скрыт'],
]

const TONE_OPTIONS = [
  ['cold', 'холодная (охлаждение)'],
  ['warm', 'тёплая (отопление)'],
]

const SLOT_OPTIONS = [
  ['', 'не показывать в первом экране'],
  ['1', 'слот 1'],
  ['2', 'слот 2'],
  ['3', 'слот 3'],
  ['4', 'слот 4'],
]

const EMPTY = { projects: [], partners: [], advantages: [], stats: [], phones: [] }

// ---------------------------------------------------------------------------
// Описание типов
// ---------------------------------------------------------------------------

// kind поля:
//   text   — строка; пустая уходит как null (сервер трактует это как «снять»);
//   select — закрытый список значений;
//   number — целое или null (идентификатор медиа);
//   slot   — то же число, но списком (слот в первом экране один из четырёх);
//   idlist — список ID через запятую (галерея проекта).
const TYPES = [
  {
    type: 'projects',
    title: 'Проекты',
    idField: 'id',
    note:
      'Название и описание проекта живут в разделе «Тексты» под ключами ' +
      'projects.<slug>.tag / .title / .card / .desc — они заводятся автоматически ' +
      'вместе с проектом.',
    labelOf: (item) => item.title || item.slug,
    thumbOf: (item) => item.cover,
    metaOf: (item) => [`slug: ${item.slug}`, `фотографий: ${item.photos?.length ?? 0}`],
    fields: [
      {
        name: 'slug',
        label: 'Slug',
        kind: 'text',
        createOnly: true,
        required: true,
        placeholder: 'tashkent-mall',
        hint: 'строчная латиница, цифры и дефис; изменить потом нельзя',
      },
      { name: 'status', label: 'Публикация', kind: 'select', options: STATUS_OPTIONS },
      {
        name: 'coverMediaId',
        label: 'ID обложки',
        kind: 'number',
        hint: 'номер файла из раздела «Медиа»; пусто — без обложки',
      },
      {
        name: 'photos',
        label: 'ID фотографий галереи',
        kind: 'idlist',
        hint: 'через запятую, в нужном порядке; не больше 30',
        read: (item) => (item.photos ?? []).map((photo) => photo.mediaId).join(', '),
      },
    ],
  },
  {
    type: 'partners',
    title: 'Партнёры',
    idField: 'id',
    note: 'Названия партнёров не переводятся — это данные, а не текст сайта.',
    labelOf: (item) => item.name,
    thumbOf: (item) => item.logo,
    metaOf: (item) => (item.url ? [item.url] : []),
    fields: [
      { name: 'name', label: 'Название', kind: 'text', required: true },
      {
        name: 'url',
        label: 'Ссылка',
        kind: 'text',
        placeholder: 'https://example.com',
        hint: 'только https; пусто — логотип без ссылки',
      },
      { name: 'mediaId', label: 'ID логотипа', kind: 'number' },
      { name: 'status', label: 'Публикация', kind: 'select', options: STATUS_OPTIONS },
    ],
  },
  {
    type: 'advantages',
    title: 'Преимущества',
    idField: 'id',
    note:
      'Заголовок и описание карточки правятся в разделе «Тексты» под ключами ' +
      'services.<slug>.title и services.<slug>.desc.',
    labelOf: (item) => item.title || item.slug,
    thumbOf: (item) => item.icon,
    metaOf: (item) => [`slug: ${item.slug}`, `подача: ${item.tone === 'warm' ? 'тёплая' : 'холодная'}`],
    fields: [
      {
        name: 'slug',
        label: 'Slug',
        kind: 'text',
        createOnly: true,
        required: true,
        placeholder: 'service-install',
        hint: 'строчная латиница, цифры и дефис; изменить потом нельзя',
      },
      { name: 'tone', label: 'Подача карточки', kind: 'select', options: TONE_OPTIONS },
      { name: 'iconMediaId', label: 'ID иконки', kind: 'number' },
      { name: 'status', label: 'Публикация', kind: 'select', options: STATUS_OPTIONS },
    ],
  },
  {
    type: 'stats',
    title: 'Цифры',
    idField: 'key',
    note:
      'Подпись к цифре правится в разделе «Тексты» под ключом ratings.<ключ>. ' +
      'Значение — готовая строка: «450+», «24/7», «12».',
    labelOf: (item) => `${item.value} — ${item.label || item.key}`,
    thumbOf: () => null,
    metaOf: (item) => [
      `ключ: ${item.key}`,
      item.heroSlot ? `первый экран, слот ${item.heroSlot}` : 'только в общем блоке',
    ],
    fields: [
      {
        name: 'key',
        label: 'Ключ',
        kind: 'text',
        createOnly: true,
        required: true,
        placeholder: 'objects_done',
        hint: 'строчная латиница, цифры и подчёркивание; изменить потом нельзя',
      },
      { name: 'value', label: 'Значение', kind: 'text', required: true, placeholder: '450+' },
      { name: 'tone', label: 'Подача', kind: 'select', options: TONE_OPTIONS },
      { name: 'heroSlot', label: 'Слот первого экрана', kind: 'slot', options: SLOT_OPTIONS },
    ],
  },
  {
    type: 'phones',
    title: 'Телефоны',
    idField: 'id',
    note: 'Хранится строго в формате E.164: из него собирается и ссылка tel:, и вид на сайте.',
    labelOf: (item) => item.e164,
    thumbOf: () => null,
    metaOf: () => [],
    fields: [
      {
        name: 'e164',
        label: 'Телефон',
        kind: 'text',
        required: true,
        placeholder: '+998901234567',
        hint: 'плюс и цифры, без пробелов и скобок',
      },
      { name: 'status', label: 'Публикация', kind: 'select', options: STATUS_OPTIONS },
    ],
  },
]

// ---------------------------------------------------------------------------
// Значения формы
// ---------------------------------------------------------------------------

/** Значение поля в виде строки для input. Формы работают только со строками. */
const readField = (field, item) => {
  if (field.read) return field.read(item)
  const value = item?.[field.name]
  if (value == null) return ''
  return String(value)
}

const defaultValue = (field) => {
  if (field.kind === 'select') return field.options[0][0]
  if (field.kind === 'slot') return ''
  return ''
}

/**
 * Строка формы -> значение для API. Бросает Error с человеческим текстом:
 * поймать опечатку в номере файла до запроса дешевле, чем после отказа сервера.
 */
const writeField = (field, raw) => {
  const text = String(raw ?? '').trim()

  if (field.kind === 'number' || field.kind === 'slot') {
    if (!text) return null
    if (!/^\d{1,10}$/.test(text)) throw new Error(`${field.label}: нужно число`)
    return Number(text)
  }

  if (field.kind === 'idlist') {
    if (!text) return []
    const ids = text.split(/[\s,;]+/).filter(Boolean)
    if (ids.some((id) => !/^\d{1,10}$/.test(id))) {
      throw new Error(`${field.label}: только номера файлов через запятую`)
    }
    return ids.map(Number)
  }

  if (field.required && !text) throw new Error(`${field.label}: поле обязательно`)
  // Пустая необязательная строка — это «снять значение», и сервер ждёт здесь
  // null: пустая строка в колонке url означала бы ссылку в никуда.
  if (!text) return field.required ? '' : null
  return text
}

const buildPayload = (fields, values, { creating }) => {
  const payload = {}
  for (const field of fields) {
    if (field.createOnly && !creating) continue
    payload[field.name] = writeField(field, values[field.name])
  }
  return payload
}

// ---------------------------------------------------------------------------
// Форма
// ---------------------------------------------------------------------------

const EntityForm = ({ fields, item, creating, busy, onSubmit, onCancel, onDirtyChange }) => {
  const [initial] = useState(() => {
    const start = {}
    for (const field of fields) {
      start[field.name] = item ? readField(field, item) : defaultValue(field)
    }
    return start
  })
  const [values, setValues] = useState(initial)
  const [error, setError] = useState('')

  // Наверх уходит только факт «есть несохранённое»: экран решает по нему,
  // спрашивать ли подтверждение перед уходом, и знать о самих значениях
  // ему не нужно.
  const dirty = fields.some((field) => values[field.name] !== initial[field.name])
  useEffect(() => {
    onDirtyChange?.(dirty)
    // Форма может размонтироваться грязной (переключили вкладку) — флаг
    // обязан погаснуть вместе с ней, иначе он останется взведённым навсегда.
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }))

  const submit = (event) => {
    event.preventDefault()
    try {
      setError('')
      onSubmit(buildPayload(fields, values, { creating }))
    } catch (validation) {
      setError(validation.message)
    }
  }

  return (
    <form className="adm-form" onSubmit={submit}>
      {fields
        .filter((field) => creating || !field.createOnly)
        .map((field) => (
          <label key={field.name} className="adm-field">
            <span className="adm-label">{field.label}</span>

            {field.kind === 'select' || field.kind === 'slot' ? (
              <select
                className="adm-select"
                value={values[field.name]}
                disabled={busy}
                onChange={(event) => set(field.name, event.target.value)}
              >
                {field.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="adm-input"
                value={values[field.name]}
                placeholder={field.placeholder ?? ''}
                disabled={busy}
                // inputMode на телефоне даёт цифровую клавиатуру, но тип
                // оставляем text: number-поле в браузере молча съедает
                // ведущие нули и разделители списка.
                inputMode={field.kind === 'number' || field.kind === 'idlist' ? 'numeric' : 'text'}
                onChange={(event) => set(field.name, event.target.value)}
              />
            )}

            {/* Поля, хранящие идентификаторы файлов, получают выбор из
                библиотеки. Само поле остаётся: пикер — это удобство, а не
                единственный способ ввода. */}
            {field.kind === 'number' || field.kind === 'idlist' ? (
              <MediaPicker
                value={values[field.name]}
                multiple={field.kind === 'idlist'}
                disabled={busy}
                onPick={(next) => set(field.name, next)}
              />
            ) : null}

            {field.hint ? <span className="adm-hint">{field.hint}</span> : null}
          </label>
        ))}

      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="adm-form__actions">
        <button type="submit" className="adm-btn adm-btn--primary" disabled={busy}>
          {creating ? 'Создать' : 'Сохранить'}
        </button>
        <button type="button" className="adm-btn adm-btn--ghost" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

const Entities = ({ session }) => {
  const canWrite = session.capabilities?.['content.write'] === true
  const [entities, setEntities] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState(null)

  const [activeType, setActiveType] = useState(TYPES[0].type)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState('')

  // Незакрытые правки в открытой форме. Переключение вкладки размонтирует
  // форму вместе со всем набранным, и раньше это происходило молча — потерять
  // заполненную карточку проекта можно было одним промахом по вкладке.
  const [dirty, setDirty] = useState(false)
  const [pendingType, setPendingType] = useState(null)

  // Тот же случай, но для закрытия вкладки браузера. Текст задаёт браузер,
  // наше дело — вернуть непустое значение.
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const closeForms = useCallback(() => {
    setCreating(false)
    setEditingId(null)
    setDirty(false)
  }, [])

  const switchType = (type) => {
    if (type === activeType) return
    if (dirty) {
      setPendingType(type)
      return
    }
    setActiveType(type)
    closeForms()
    setNotice(null)
  }

  const confirmSwitch = () => {
    setActiveType(pendingType)
    setPendingType(null)
    closeForms()
    setNotice(null)
  }

  const apply = (data) => {
    // Все мутации возвращают полный набор сущностей — берём его как есть.
    if (data?.entities) {
      setEntities({ ...EMPTY, ...data.entities })
      return true
    }
    return false
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get('/api/admin/entities')
      if (data?.ok === false) throw data
      setEntities({ ...EMPTY, ...data })
      setLoadError('')
    } catch (error) {
      setLoadError(errorText(error, 'Не удалось загрузить данные блоков'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** Общая обёртка мутации: занятость, разбор ответа и сообщение об ошибке. */
  const run = async (key, action, success) => {
    setBusy(key)
    setNotice(null)
    try {
      const data = await action()
      if (data?.ok === false) throw data
      if (!apply(data)) await load()
      if (success) setNotice({ kind: 'ok', text: success(data) })
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
      return false
    } finally {
      setBusy('')
    }
  }

  const conf = TYPES.find((item) => item.type === activeType) ?? TYPES[0]
  const list = entities[conf.type] ?? []

  const create = async (payload) => {
    const done = await run(
      `create:${conf.type}`,
      () => api.post(`/api/admin/entities/${conf.type}`, payload),
      (data) =>
        data?.restoredKeys
          ? `Создано. Восстановлено текстов из архива: ${data.restoredKeys}.`
          : 'Создано. Тексты заведены пустыми — заполните их в разделе «Тексты».'
    )
    if (done) closeForms()
  }

  const update = async (id, payload) => {
    const done = await run(
      `update:${id}`,
      () => api.put(`/api/admin/entities/${conf.type}/${encodeURIComponent(id)}`, payload),
      () => 'Сохранено.'
    )
    if (done) closeForms()
  }

  const remove = (id) =>
    run(
      `delete:${id}`,
      () => api.del(`/api/admin/entities/${conf.type}/${encodeURIComponent(id)}`),
      (data) =>
        // Тексты удалённой записи не стираются, а уезжают под префикс archived.
        // Сказать об этом обязательно: иначе «удалил по ошибке» выглядит как
        // потеря четырёх языков перевода.
        `Удалено. Текстов убрано в архив: ${data?.archivedRows ?? 0} — они вернутся, ` +
        'если завести запись с тем же идентификатором.'
    )

  /**
   * Скрыть или опубликовать прямо из списка.
   *
   * Раньше единственным способом было открыть форму, найти в ней селект
   * публикации и сохранить — три действия там, где смысл ровно один
   * и обратимый. Сервер применяет частичное обновление, поэтому в теле
   * уходит только статус: остальные поля записи не участвуют и не могут
   * пострадать от того, что форма не открывалась.
   */
  const toggleStatus = (id, current) =>
    run(
      `update:${id}`,
      () =>
        api.put(`/api/admin/entities/${conf.type}/${encodeURIComponent(id)}`, {
          status: current === 'published' ? 'hidden' : 'published',
        }),
      () => (current === 'published' ? 'Скрыто с сайта.' : 'Опубликовано.')
    )

  const move = (index, delta) => {
    const target = index + delta
    if (target < 0 || target >= list.length) return undefined

    const ids = list.map((item) => item[conf.idField])
    const reordered = [...ids]
    reordered[index] = ids[target]
    reordered[target] = ids[index]

    return run(`reorder:${conf.type}`, () =>
      api.post(`/api/admin/entities/${conf.type}/reorder`, { ids: reordered })
    )
  }

  return (
    <section className="adm-screen adm-screen--entities">
      <header className="adm-screen__head">
        <h1 className="adm-screen__title">Блоки лендинга</h1>
        <p className="adm-muted">
          Порядок карточек на сайте — это порядок в этом списке. Тексты правятся
          отдельно, в разделе «Тексты»: у каждой записи пять языков.
        </p>
      </header>

      {!canWrite ? (
        <Notice kind="info">У вашей роли блоки доступны только для чтения.</Notice>
      ) : null}

      <nav className="adm-tabs">
        {TYPES.map((item) => (
          <button
            key={item.type}
            type="button"
            className={`adm-tab${item.type === activeType ? ' adm-tab--active' : ''}`}
            onClick={() => switchType(item.type)}
          >
            {item.title} ({(entities[item.type] ?? []).length})
          </button>
        ))}
      </nav>

      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      {pendingType && (
        <Notice kind="error">
          В открытой форме есть несохранённые правки. Переход в другой раздел их
          потеряет.
          <span className="adm-row">
            <button type="button" className="adm-btn adm-btn--danger" onClick={confirmSwitch}>
              Перейти и потерять
            </button>
            <button
              type="button"
              className="adm-btn adm-btn--ghost"
              onClick={() => setPendingType(null)}
            >
              Остаться
            </button>
          </span>
        </Notice>
      )}

      <Notice kind="info">{conf.note}</Notice>

      <div className="adm-toolbar">
        {canWrite ? (
          <button
            type="button"
            className="adm-btn adm-btn--primary"
            onClick={() => {
              const next = !creating
              closeForms()
              setCreating(next)
            }}
            disabled={Boolean(busy)}
          >
            {creating ? 'Не создавать' : `Добавить в «${conf.title}»`}
          </button>
        ) : null}
        <button type="button" className="adm-btn" onClick={load} disabled={loading}>
          Обновить
        </button>
      </div>

      {creating && (
        <div className="adm-card adm-card--form">
          <h2 className="adm-card__title">Новая запись</h2>
          <EntityForm
            key={`create:${conf.type}`}
            fields={conf.fields}
            item={null}
            creating
            busy={busy === `create:${conf.type}`}
            onSubmit={create}
            onCancel={closeForms}
            onDirtyChange={setDirty}
          />
        </div>
      )}

      {loading && !list.length ? <p className="adm-muted">Загружаю…</p> : null}
      {!loading && !list.length ? <p className="adm-muted">Пока ничего нет.</p> : null}

      <ol className="adm-list">
        {list.map((item, index) => {
          const id = item[conf.idField]
          const thumb = conf.thumbOf(item)
          const editing = editingId === id

          return (
            <li key={id} className="adm-card adm-entity">
              <div className="adm-entity__row">
                {canWrite ? (
                  <OrderButtons
                    onUp={() => move(index, -1)}
                    onDown={() => move(index, 1)}
                    canUp={index > 0}
                    canDown={index < list.length - 1}
                    disabled={Boolean(busy)}
                  />
                ) : null}

                {thumb ? (
                  <img className="adm-entity__thumb" src={thumb.url} alt="" loading="lazy" />
                ) : (
                  <span className="adm-entity__thumb adm-entity__thumb--empty" aria-hidden="true" />
                )}

                <div className="adm-entity__main">
                  <div className="adm-entity__title">{conf.labelOf(item)}</div>
                  <div className="adm-muted">
                    {conf.metaOf(item).join(' · ')}
                    {item.photos?.some((photo) => photo.deleted) ? (
                      <span className="adm-warn"> · в галерее есть удалённые файлы</span>
                    ) : null}
                  </div>
                </div>

                {item.status ? <StatusBadge status={item.status} /> : null}

                {canWrite ? <div className="adm-entity__actions">
                  {item.status ? (
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => toggleStatus(id, item.status)}
                      disabled={Boolean(busy)}
                    >
                      {item.status === 'published' ? 'Скрыть' : 'Опубликовать'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="adm-btn"
                    onClick={() => {
                      const next = editing ? null : id
                      closeForms()
                      setEditingId(next)
                    }}
                    disabled={Boolean(busy)}
                  >
                    {editing ? 'Закрыть' : 'Изменить'}
                  </button>
                  <ConfirmButton onConfirm={() => remove(id)} disabled={Boolean(busy)} />
                </div> : null}
              </div>

              {editing && (
                <EntityForm
                  key={`edit:${conf.type}:${id}`}
                  fields={conf.fields}
                  item={item}
                  creating={false}
                  busy={busy === `update:${id}`}
                  onSubmit={(payload) => update(id, payload)}
                  onCancel={closeForms}
                  onDirtyChange={setDirty}
                />
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default Entities
