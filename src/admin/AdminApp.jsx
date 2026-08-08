// Корень админки: сессия, каркас и маршрутизация по хешу.
//
// МАРШРУТИЗАТОР — ХЕШ, И ЭТО НЕ ЛЕНЬ. Разделов около семи, вложенности нет.
// react-router добавил бы к бандлу больше кода, чем весит весь этот файл,
// а главное — админка живёт по секретному адресу вида /<24-символьный-путь>.
// History API заставил бы держать базовый путь в клиенте и следить, чтобы
// он не утёк ни в один <a href>: секретный путь и так виден в адресной строке,
// но размножать его по разметке незачем. Хеш на сервер не уходит вовсе,
// то есть ни в логи прокси, ни в Referer он не попадает.
//
// ЭКРАНЫ ПОДКЛЮЧАЮТСЯ СНАРУЖИ. Разделы контента, сущностей, медиа, заявок
// и настроек пишутся отдельно; здесь они не импортируются, а приходят пропом
// screens. Так каркас не приходится править ради каждого нового раздела,
// и незаконченный раздел не ломает вход в панель — вместо него показывается
// заглушка.

import { useCallback, useEffect, useMemo, useState } from 'react'

import ChangePassword from './screens/ChangePassword.jsx'
import Login from './screens/Login.jsx'
import Security from './screens/Security.jsx'
import Setup2fa from './screens/Setup2fa.jsx'
import { useSession } from './useSession.js'
import './admin.css'

// Порядок пунктов меню. id совпадает с хешем: #/leads — это раздел 'leads'.
const SECTIONS = [
  { id: 'overview', title: 'Обзор', capability: 'dashboard.read' },
  { id: 'content', title: 'Тексты', capability: 'content.read' },
  { id: 'entities', title: 'Каталоги', capability: 'content.read' },
  { id: 'media', title: 'Медиа', capability: 'media.read' },
  { id: 'leads', title: 'Заявки', capability: 'leads.read' },
  // Та же капабилити, что у «Обзора»: данные агрегатные, без ПДн, и роль,
  // которой видно число заявок, вправе видеть и их источники.
  { id: 'analytics', title: 'Аналитика', capability: 'dashboard.read' },
  { id: 'settings', title: 'Настройки', capability: 'settings.manage' },
  // Только владелец: капабилити users.manage роли admin не выдана намеренно.
  { id: 'users', title: 'Пользователи', capability: 'users.manage' },
  { id: 'security', title: 'Безопасность', capability: 'security.self_manage' },
]

const DEFAULT_SECTION = 'overview'

/** Разбор '#/leads/42?status=new' в { id, params, search }. */
const readRoute = () => {
  const raw = String(window.location.hash || '').replace(/^#\/?/, '')
  const [path, query] = raw.split('?')
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        // Битая escape-последовательность в адресной строке — не повод падать.
        return part
      }
    })

  return {
    id: segments[0] || DEFAULT_SECTION,
    params: segments.slice(1),
    search: new URLSearchParams(query || ''),
  }
}

const useHashRoute = () => {
  const [route, setRoute] = useState(readRoute)

  useEffect(() => {
    const onChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onChange)
    // Хеш мог измениться между первым чтением и подпиской (React 18
    // монтирует эффекты не мгновенно).
    onChange()
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

const navigate = (id) => {
  window.location.hash = `#/${id}`
}

const formatTime = (timestamp) => {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** Раздел, который ещё не подключён к каркасу. */
const Placeholder = ({ title }) => (
  <section className="adm-panel">
    <header className="adm-panel__head">
      <h1 className="adm-panel__title">{title}</h1>
    </header>
    <p className="adm-text">Раздел ещё не подключён к панели.</p>
  </section>
)

const Overview = ({ session }) => (
  <section className="adm-panel">
    <header className="adm-panel__head">
      <h1 className="adm-panel__title">Обзор</h1>
      <p className="adm-panel__hint">
        Панель управления сайтом PROHVAC: тексты, каталоги, медиа, заявки и настройки.
      </p>
    </header>

    <dl className="adm-meta">
      <div>
        <dt>Пользователь</dt>
        <dd>{session.user?.username || '—'}</dd>
      </div>
      <div>
        <dt>Роль</dt>
        <dd>{session.user?.role || '—'}</dd>
      </div>
      <div>
        <dt>Способ входа</dt>
        <dd>{session.amr || '—'}</dd>
      </div>
      <div>
        <dt>Сессия до</dt>
        <dd>{formatTime(session.expiresAt) || '—'}</dd>
      </div>
    </dl>
  </section>
)

const Splash = ({ text }) => (
  <div className="adm-splash">
    <span className="adm-splash__dot" aria-hidden="true" />
    <p>{text}</p>
  </div>
)

/**
 * Админка целиком.
 *
 * @param {{screens?: Array<{id: string, title?: string, Component: Function}>}} props
 *   screens — разделы, написанные отдельно. Совпадающие по id заменяют
 *   встроенные, новые добавляются в конец меню.
 */
const AdminApp = ({ screens = [] }) => {
  const session = useSession()
  const route = useHashRoute()

  // Меню и таблица экранов считаются вместе: пункт без компонента должен
  // показывать заглушку, а не пропадать из навигации — иначе непонятно,
  // существует раздел вообще или его просто не видно этой роли.
  const sections = useMemo(() => {
    const merged = SECTIONS.map((section) => {
      const custom = screens.find((item) => item.id === section.id)
      return custom ? { ...section, ...custom } : section
    })
    const extra = screens.filter((item) => !SECTIONS.some((section) => section.id === item.id))
    return [...merged, ...extra.map((item) => ({ title: item.id, ...item }))]
      .filter((section) => session.capabilities?.[section.capability] === true)
  }, [screens, session.capabilities])

  const active = sections.find((section) => section.id === route.id) || sections[0]

  // Запрет на работу с временным или слабым паролем.
  //
  // Флаг «липкий»: он взводится от session.mustChangePassword, но сам по себе
  // не гаснет. Иначе успешная смена мгновенно снимала бы условие, экран
  // размонтировался бы прямо в момент ответа сервера, и человек не увидел бы
  // ни подтверждения, ни числа разлогиненных устройств — панель просто
  // моргнула бы. Снимает флаг только кнопка на экране подтверждения.
  const [passwordGate, setPasswordGate] = useState(false)
  useEffect(() => {
    if (session.mustChangePassword) setPasswordGate(true)
  }, [session.mustChangePassword])

  const goOverview = useCallback(() => navigate(DEFAULT_SECTION), [])

  const leavePasswordGate = useCallback(() => {
    setPasswordGate(false)
    goOverview()
  }, [goOverview])

  if (session.status === 'loading') return <Splash text="Проверяем сессию…" />
  // Пароль принят, но приложение-аутентификатор ещё не привязано. Показываем
  // только экран привязки: панель на этой стадии всё равно закрыта сервером,
  // а её каркас с пустыми полями сбивал бы с толку.
  if (session.status === 'enroll') return <Setup2fa session={session} />
  if (session.status !== 'active') return <Login session={session} />
  // Панель закрыта целиком, а не украшена предупреждением: временный пароль
  // передают голосом или в мессенджере, а слабый подбирается, и до смены такой
  // сессии нечего делать рядом с заявками клиентов.
  if (passwordGate) {
    return (
      <div className="adm-root adm-root--gate">
        <main className="adm-main">
          <ChangePassword session={session} onDone={leavePasswordGate} />
        </main>
      </div>
    )
  }

  const Screen = active?.id === 'security' && !active?.Component
    ? Security
    : active?.Component

  return (
    <div className="adm-root">
      <header className="adm-top">
        <div className="adm-top__brand">
          PROHVAC<span className="adm-top__brand-tail">панель</span>
        </div>

        <div className="adm-top__side">
          <span className="adm-top__user">
            {session.user?.username}
            {session.user?.role ? <span className="adm-top__role">{session.user.role}</span> : null}
          </span>
          <span className="adm-top__clock" title="Сессия истечёт">
            до {formatTime(session.expiresAt)}
          </span>
          <button
            className="adm-btn adm-btn--ghost"
            type="button"
            onClick={session.signOut}
            disabled={session.busy}
          >
            Выйти
          </button>
        </div>
      </header>

      <nav className="adm-nav" aria-label="Разделы панели">
        {sections.map((section) => (
          <button
            key={section.id}
            className={`adm-nav__item${section.id === active?.id ? ' adm-nav__item--active' : ''}`}
            type="button"
            onClick={() => navigate(section.id)}
            aria-current={section.id === active?.id ? 'page' : undefined}
          >
            {section.title}
          </button>
        ))}
      </nav>

      <main className="adm-main">
        {!session.totpEnrolled && (
          <p className="adm-warning">
            Вход выполнен без кода из приложения.{' '}
            <button className="adm-link" type="button" onClick={() => navigate('security')}>
              Привязать второй фактор
            </button>
          </p>
        )}

        {session.error && (
          <p className="adm-notice adm-notice--error" role="alert">
            Сервер вернул ошибку: {session.error}
          </p>
        )}

        {Screen ? (
          <Screen session={session} route={route} onDone={goOverview} />
        ) : active?.id === DEFAULT_SECTION ? (
          <Overview session={session} />
        ) : (
          <Placeholder title={active?.title || 'Нет доступных разделов'} />
        )}
      </main>
    </div>
  )
}

export default AdminApp
