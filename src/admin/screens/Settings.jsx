// Экран настроек: бот, форма заявки, переводы, хранилище и SEO.
//
// СЕКРЕТ НИКОГДА НЕ ПРИЕЗЖАЕТ В БРАУЗЕР. Сервер отдаёт по секретным ключам
// только маску вида 'dpl_****4f2a' и признак «задано» (см. шапку
// server/routes/admin.settings.js). Отсюда главное правило этого экрана:
// поле секрета ВСЕГДА пустое, а значение уходит на сервер только если человек
// его руками набрал. Подставить туда маску и отправить её обратно значило бы
// однажды записать в токен бота строку из звёздочек.
//
// «ЗАМЕНИТЬ» — ОТДЕЛЬНОЕ ДЕЙСТВИЕ. Пока кнопку не нажали, поля ввода нет
// вовсе: случайный клик и нажатие клавиши не должны иметь шанса затереть
// рабочий токен. Снятие секрета тоже явное — «Очистить».
//
// ФОРМА СТРОИТСЯ ПО ОТВЕТУ СЕРВЕРА. Список ключей и их типы задаёт
// SETTINGS_SCHEMA на сервере, и он же присылает подсказки. Здесь только
// человеческие названия и разбиение на группы: дублировать схему на клиенте
// значило бы получить два расходящихся списка настроек.

import { useCallback, useEffect, useState } from 'react'

import {
  SETTING_KEYS,
  TARGET_LOCALES,
  TRANSLATION_PROVIDERS_BY_LANG,
  defaultTranslationRouting,
  normalizeTranslationRouting,
} from '../../../shared/settings.js'
import { api } from '../api.js'
import ConfirmButton from '../components/ConfirmButton.jsx'
import Notice from '../components/Notice.jsx'
import { errorCode, errorText, formatDateTime } from '../components/format.js'

// Названия по-русски. Ключ, которого здесь нет (появился на сервере раньше,
// чем в этом файле), показывается как есть — вместе с подсказкой от сервера
// этого достаточно, чтобы им можно было пользоваться.
const LABELS = {
  [SETTING_KEYS.TELEGRAM_BOT_TOKEN]: 'Токен бота',
  [SETTING_KEYS.TELEGRAM_CHAT_ID]: 'Чат для заявок',
  [SETTING_KEYS.TELEGRAM_TEMPLATE]: 'Шаблон сообщения',
  [SETTING_KEYS.TELEGRAM_ENABLED]: 'Отправлять заявки в Telegram',
  [SETTING_KEYS.LEAD_RATE_MAX]: 'Заявок с одного адреса за окно',
  [SETTING_KEYS.LEAD_RATE_WINDOW_MS]: 'Длина окна ограничения, мс',
  [SETTING_KEYS.FORM_REQUIRE_MESSAGE]: 'Требовать текст сообщения в форме',
  [SETTING_KEYS.DEEPL_API_KEY]: 'Ключ DeepL',
  [SETTING_KEYS.TRANSLATION_ROUTING]: 'Кто переводит на каждый язык',
  [SETTING_KEYS.TRANSLATION_PROTECTED_TERMS]: 'Термины без перевода',
  [SETTING_KEYS.MEDIA_QUOTA_BYTES]: 'Квота хранилища, байт',
  [SETTING_KEYS.SEO_TITLE]: 'Заголовок страницы',
  [SETTING_KEYS.SEO_DESCRIPTION]: 'Описание для поисковиков',
  [SETTING_KEYS.SEO_OG_IMAGE]: 'Картинка для соцсетей',
}

const GROUPS = [
  { id: 'telegram', title: 'Телеграм-бот', match: (key) => key.startsWith('telegram.') },
  {
    id: 'form',
    title: 'Форма заявки',
    match: (key) => key.startsWith('lead.') || key.startsWith('form.'),
  },
  {
    id: 'translation',
    title: 'Переводы',
    match: (key) => key.startsWith('translation.'),
  },
  { id: 'media', title: 'Медиа', match: (key) => key.startsWith('media.') },
  { id: 'seo', title: 'SEO', match: (key) => key.startsWith('seo.') },
  { id: 'other', title: 'Прочее', match: () => true },
]

const LANGUAGE_LABELS = Object.freeze({
  en: 'Английский',
  uz: 'Узбекский',
  tr: 'Турецкий',
  ar: 'Арабский',
})

const PROVIDER_LABELS = Object.freeze({
  deepl: 'DeepL',
  mymemory: 'MyMemory',
})

const ROUTING_LANGS = TARGET_LOCALES.map((lang) => [lang, LANGUAGE_LABELS[lang] ?? lang])
const ROUTING_KEY = SETTING_KEYS.TRANSLATION_ROUTING
const TERMS_KEY = SETTING_KEYS.TRANSLATION_PROTECTED_TERMS

const routingOptions = (lang) => {
  const providers = TRANSLATION_PROVIDERS_BY_LANG[lang] ?? []
  const routes = [[], ...providers.map((provider) => [provider])]
  if (providers.length > 1) {
    routes.push([...providers], [...providers].reverse())
  }
  return routes.map((route) => ({
    route,
    value: JSON.stringify(route),
    label: route.length
      ? route.map((provider) => PROVIDER_LABELS[provider] ?? provider).join(' → ')
      : 'только вручную',
  }))
}

// ---------------------------------------------------------------------------
// Значения
// ---------------------------------------------------------------------------

/** Значение настройки в том виде, в каком его правит форма. */
const draftOf = (item) => {
  // Секрет наружу не отдаётся вовсе — правка начинается с пустого поля.
  if (item.isSecret) return ''
  if (item.key === ROUTING_KEY) {
    const normalized = normalizeTranslationRouting(item.value ?? defaultTranslationRouting())
    return normalized.ok ? normalized.value : defaultTranslationRouting()
  }
  // Термины редактируются построчно: список из десятков названий в одну
  // строку через запятую нечитаем.
  if (item.key === TERMS_KEY) return (item.value ?? []).join('\n')
  if (item.type === 'json') return JSON.stringify(item.value ?? null, null, 2)
  if (item.type === 'bool') return Boolean(item.value)
  return item.value == null ? '' : String(item.value)
}

/** Значение для API. Бросает Error с текстом для человека. */
const valueOf = (item, draft) => {
  if (item.isSecret) return String(draft ?? '')
  if (item.key === ROUTING_KEY) {
    const normalized = normalizeTranslationRouting(draft)
    if (!normalized.ok) throw new Error(normalized.reason)
    return normalized.value
  }
  if (item.key === TERMS_KEY) {
    return String(draft ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }
  if (item.type === 'json') {
    try {
      return JSON.parse(String(draft ?? ''))
    } catch {
      throw new Error('Значение должно быть корректным JSON')
    }
  }
  if (item.type === 'bool') return Boolean(draft)
  if (item.type === 'int') {
    const text = String(draft ?? '').trim()
    if (!/^\d{1,15}$/.test(text)) throw new Error('Нужно целое число')
    return Number(text)
  }
  return String(draft ?? '')
}

const isDirty = (item, draft) => {
  if (item.isSecret) return String(draft ?? '').length > 0
  return JSON.stringify(draft) !== JSON.stringify(draftOf(item))
}

// ---------------------------------------------------------------------------
// Редактор одной настройки
// ---------------------------------------------------------------------------

const SecretEditor = ({ item, draft, replacing, reveal, onChange, onReveal, onReplace }) => (
  <div className="adm-setting__editor">
    <div className="adm-secret">
      <code className="adm-secret__mask">{item.isSet ? item.preview || '••••' : 'не задан'}</code>
      <button type="button" className="adm-btn" onClick={() => onReplace(!replacing)}>
        {replacing ? 'Не менять' : 'Заменить'}
      </button>
    </div>

    {replacing && (
      <>
        <input
          className="adm-input"
          type={reveal ? 'text' : 'password'}
          value={draft}
          // Менеджеры паролей не должны предлагать сюда сохранённые пароли
          // и тем более подставлять их автоматически.
          autoComplete="new-password"
          spellCheck={false}
          placeholder="вставьте новое значение"
          onChange={(event) => onChange(event.target.value)}
        />
        <label className="adm-check">
          <input type="checkbox" checked={reveal} onChange={(event) => onReveal(event.target.checked)} />
          Показать введённое
        </label>
      </>
    )}
  </div>
)

const RoutingEditor = ({ draft, onChange }) => (
  <div className="adm-routing">
    {ROUTING_LANGS.map(([lang, title]) => {
      const options = routingOptions(lang)
      const selected = JSON.stringify(draft?.[lang] ?? [])
      return (
        <label key={lang} className="adm-field adm-field--inline">
          <span className="adm-label">{title}</span>
          <select
            className="adm-select"
            value={selected}
            onChange={(event) => onChange({ ...draft, [lang]: JSON.parse(event.target.value) })}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )
    })}
  </div>
)

const ValueEditor = ({ item, draft, onChange }) => {
  if (item.key === ROUTING_KEY) return <RoutingEditor draft={draft} onChange={onChange} />

  if (item.type === 'bool') {
    return (
      <label className="adm-check">
        <input
          type="checkbox"
          checked={Boolean(draft)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {draft ? 'включено' : 'выключено'}
      </label>
    )
  }

  if (item.type === 'text' || item.type === 'json' || item.key === TERMS_KEY) {
    return (
      <textarea
        className="adm-textarea"
        rows={item.key === TERMS_KEY ? 6 : 8}
        value={String(draft ?? '')}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }

  return (
    <input
      className="adm-input"
      type="text"
      value={String(draft ?? '')}
      inputMode={item.type === 'int' ? 'numeric' : 'text'}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

const Settings = () => {
  const [items, setItems] = useState([])
  const [drafts, setDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notices, setNotices] = useState({})
  const [saving, setSaving] = useState('')

  const [replacing, setReplacing] = useState({})
  const [reveal, setReveal] = useState({})

  const [testing, setTesting] = useState(false)
  const [webhookBusy, setWebhookBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get('/api/admin/settings')
      if (data?.ok === false) throw data

      const list = Array.isArray(data?.items) ? data.items : []
      setItems(list)
      setDrafts(Object.fromEntries(list.map((item) => [item.key, draftOf(item)])))
      setLoadError('')
    } catch (error) {
      setLoadError(errorText(error, 'Не удалось загрузить настройки'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const setNotice = (key, kind, text) =>
    setNotices((current) => ({ ...current, [key]: { kind, text } }))

  const change = (key, value) => setDrafts((current) => ({ ...current, [key]: value }))

  const save = async (item, override) => {
    let value
    try {
      value = override === undefined ? valueOf(item, drafts[item.key]) : override
    } catch (validation) {
      setNotice(item.key, 'error', validation.message)
      return
    }

    setSaving(item.key)
    try {
      const data = await api.put('/api/admin/settings', { key: item.key, value })
      if (data?.ok === false) throw data

      setNotice(item.key, 'ok', 'Сохранено.')
      setReplacing((current) => ({ ...current, [item.key]: false }))
      setReveal((current) => ({ ...current, [item.key]: false }))
      // Перечитываем список целиком: сервер возвращает новую маску секрета
      // и время правки, а собирать их на клиенте — лишний повод разойтись
      // с тем, что реально записано.
      await load()
    } catch (error) {
      setNotice(item.key, 'error', errorText(error, 'Не удалось сохранить настройку'))
    } finally {
      setSaving('')
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const data = await api.post('/api/admin/settings/telegram-test', {})
      if (data?.ok === false) throw data

      setTestResult({
        kind: data?.degraded ? 'error' : 'ok',
        text: data?.degraded
          ? 'Сообщение доставлено, НО разметка шаблона сломана — Telegram отверг ' +
            'её, и карточка ушла простым текстом. Почините шаблон.'
          : `Сообщение ушло в чат ${data?.chatId ?? '—'}` +
            (data?.botUsername ? ` от бота @${data.botUsername}` : '') +
            (data?.messageId ? ` (id ${data.messageId})` : '') +
            '. Проверьте, что оно выглядит так, как задумано.',
      })
    } catch (error) {
      const code = errorCode(error)
      const retry = error?.retryAfterSec ?? error?.data?.retryAfterSec
      // Описание от Telegram — единственное, что говорит, ЧТО именно чинить,
      // поэтому оно показывается целиком, а не сворачивается в «не ушло».
      const description = error?.description ?? error?.data?.description ?? ''
      const specific =
        code === 'api_base_overridden'
          ? description
          : code === 'telegram_unauthorized'
            ? 'Токен бота не принят Telegram. Проверьте его у @BotFather.'
            : code === 'telegram_chat_not_found'
              ? 'Чат не найден. Бот должен быть добавлен в чат, а chat_id — тот самый.'
              : code === 'telegram_forbidden'
                ? 'Бота выгнали из чата или заблокировали.'
                : code === 'telegram_bad_markup'
                  ? `Разметка шаблона сломана: ${description}`
                  : ''
      setTestResult({
        kind: 'error',
        text:
          specific ||
          (code === 'rate_limited' && retry
            ? `Слишком часто — повторите через ${retry} с.`
            : errorText(error, 'Тестовое сообщение не ушло') +
              (description ? ` — ${description}` : '')),
      })
    } finally {
      setTesting(false)
    }
  }

  /**
   * Подключает кнопки статуса в чате.
   *
   * Отдельным действием, а не автоматикой на старте: setWebhook сообщает
   * Telegram один адрес на бота, и процессы Passenger переустанавливали бы
   * его наперегонки.
   */
  const setWebhook = async (enable) => {
    setWebhookBusy(true)
    setTestResult(null)
    try {
      const data = await api.post('/api/admin/settings/telegram-webhook', { enable })
      if (data?.ok === false) throw data
      setTestResult({
        kind: 'ok',
        text: enable
          ? `Кнопки статуса подключены: нажатия уходят на ${data?.url ?? 'сервер'}.`
          : 'Кнопки статуса отключены — нажатия больше не обрабатываются.',
      })
    } catch (error) {
      const description = error?.description ?? error?.data?.description ?? ''
      setTestResult({
        kind: 'error',
        text: description || errorText(error, 'Не удалось изменить подключение кнопок'),
      })
    } finally {
      setWebhookBusy(false)
    }
  }

  const grouped = GROUPS.map((group) => ({
    ...group,
    items: items.filter(
      (item) => GROUPS.find((candidate) => candidate.match(item.key))?.id === group.id
    ),
  })).filter((group) => group.items.length > 0)

  return (
    <section className="adm-screen adm-screen--settings">
      <header className="adm-screen__head">
        <h1 className="adm-screen__title">Настройки</h1>
        <p className="adm-muted">
          Секреты видны только маской: сервер их наружу не отдаёт. Значение уходит
          на сервер, лишь если вы нажали «Заменить» и ввели новое.
        </p>
      </header>

      <div className="adm-toolbar">
        <button type="button" className="adm-btn" onClick={load} disabled={loading}>
          Обновить
        </button>
        <button
          type="button"
          className="adm-btn adm-btn--primary"
          onClick={sendTest}
          disabled={testing}
        >
          {testing ? 'Отправляю…' : 'Отправить тестовое сообщение'}
        </button>
        <button
          type="button"
          className="adm-btn"
          onClick={() => setWebhook(true)}
          disabled={webhookBusy}
        >
          {webhookBusy ? 'Подключаю…' : 'Подключить кнопки статуса'}
        </button>
        <button
          type="button"
          className="adm-btn adm-btn--ghost"
          onClick={() => setWebhook(false)}
          disabled={webhookBusy}
        >
          Отключить кнопки
        </button>
        <span className="adm-muted">
          Тест уходит текущим шаблоном в рабочий чат и заявкой не считается.
          Кнопки статуса позволяют менять статус заявки прямо в чате.
        </span>
      </div>

      {testResult ? <Notice kind={testResult.kind}>{testResult.text}</Notice> : null}
      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {loading && !items.length ? <p className="adm-muted">Загружаю настройки…</p> : null}

      {grouped.map((group) => (
        <section key={group.id} className="adm-card adm-group">
          <h2 className="adm-card__title">{group.title}</h2>

          {group.items.map((item) => {
            const draft = drafts[item.key]
            const dirty = isDirty(item, draft)
            const notice = notices[item.key]

            // Поля с многострочным редактором занимают весь ряд сетки: в
            // половине колонки шаблон, маршрутизация и список терминов нечитаемы.
            const wide =
              item.key === ROUTING_KEY ||
              item.key === TERMS_KEY ||
              item.type === 'text' ||
              item.type === 'json'

            return (
              <div
                key={item.key}
                className={`adm-setting${wide ? ' adm-setting--wide' : ''}`}
              >
                <div className="adm-setting__head">
                  <span className="adm-label">{LABELS[item.key] ?? item.key}</span>
                  <code className="adm-muted adm-setting__key">{item.key}</code>
                </div>

                {item.isSecret ? (
                  <SecretEditor
                    item={item}
                    draft={String(draft ?? '')}
                    replacing={Boolean(replacing[item.key])}
                    reveal={Boolean(reveal[item.key])}
                    onChange={(value) => change(item.key, value)}
                    onReveal={(value) =>
                      setReveal((current) => ({ ...current, [item.key]: value }))
                    }
                    onReplace={(value) => {
                      setReplacing((current) => ({ ...current, [item.key]: value }))
                      // Отказ от замены обязан стереть набранное: иначе строка
                      // останется в состоянии и уедет при следующем сохранении.
                      if (!value) change(item.key, '')
                    }}
                  />
                ) : (
                  <ValueEditor
                    item={item}
                    draft={draft}
                    onChange={(value) => change(item.key, value)}
                  />
                )}

                {item.hint ? <p className="adm-hint">{item.hint}</p> : null}

                <div className="adm-setting__actions">
                  <button
                    type="button"
                    className="adm-btn adm-btn--primary"
                    disabled={!dirty || saving === item.key}
                    onClick={() => save(item)}
                  >
                    {saving === item.key ? 'Сохраняю…' : 'Сохранить'}
                  </button>

                  <button
                    type="button"
                    className="adm-btn adm-btn--ghost"
                    disabled={!dirty || saving === item.key}
                    onClick={() => {
                      change(item.key, draftOf(item))
                      setReplacing((current) => ({ ...current, [item.key]: false }))
                    }}
                  >
                    Отменить
                  </button>

                  {item.isSecret && item.isSet ? (
                    // Подтверждение обязательно: снятый токен бота нельзя
                    // восстановить из панели — сервер хранит только шифротекст
                    // и отдаёт наружу одну маску. Промах по кнопке означает
                    // поход к @BotFather за новым токеном, а до тех пор
                    // заявки с сайта не доходят до отдела продаж.
                    <ConfirmButton
                      disabled={saving === item.key}
                      confirmLabel="Точно очистить"
                      // Пустое значение для секрета сервер понимает как
                      // «удалить строку», а не «записать пустоту».
                      onConfirm={() => save(item, '')}
                    >
                      Очистить
                    </ConfirmButton>
                  ) : null}

                  <span className="adm-muted">
                    {item.updatedAt ? `изменено ${formatDateTime(item.updatedAt)}` : 'по умолчанию'}
                  </span>
                </div>

                {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
              </div>
            )
          })}
        </section>
      ))}
    </section>
  )
}

export default Settings
