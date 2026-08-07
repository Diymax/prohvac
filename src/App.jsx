import { Component, Suspense, lazy, useCallback, useEffect, useState } from 'react'
import Home from './routes/Home'
import { useLocalizedText } from './hooks/useLocalizedText.js'

const AdminEntry = lazy(() => import('./AdminEntry.jsx'))

// Тексты системных состояний по умолчанию. Бандл локали приезжает по сети,
// и до его прихода t() вернул бы сам ключ: вместо «Страница не найдена»
// посетитель увидел бы system.notFound.title. Переводы лежат в
// public/locales/<lang>/translation.json под теми же ключами.
const TEXT = {
  'system.checking': 'Проверяем адрес…',
  'system.loadingPanel': 'Загружаем панель…',
  'system.retry': 'Повторить',
  'system.reload': 'Перезагрузить',
  'system.home': 'На главную',
  'system.notFound.title': 'Страница не найдена',
  'system.notFound.text': 'Проверьте адрес или вернитесь на главную страницу PROHVAC.',
  'system.unavailable.title': 'Панель временно недоступна',
  'system.unavailable.text':
    'Не удалось проверить административный API. Проверьте соединение и повторите.',
  'system.chunkFailed.title': 'Не удалось загрузить панель',
  'system.chunkFailed.text':
    'Файлы интерфейса могли обновиться. Перезагрузите страницу и попробуйте снова.',
  'system.diagnostic.summary': 'Технические данные',
  'system.diagnostic.code': 'Код ошибки',
  'system.diagnostic.requestId': 'Идентификатор запроса',
  'system.diagnostic.time': 'Время',
  'system.diagnostic.hint': 'Сообщите эти данные, если обращаетесь в поддержку.',
}

/** Отметка времени для блока диагностики: локальное время без секунд. */
const stamp = () => new Date().toISOString()

/**
 * Проверка адреса: существует ли по нему админка.
 *
 * Возвращает не только режим, но и техническую справку о неудаче — код,
 * request ID и время. Показывать её основным текстом нельзя (CR-052),
 * поэтому она уезжает в раскрываемый блок.
 */
const probeAdmin = async (signal) => {
  try {
    const response = await fetch('/api/admin/session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    })
    if (response.status === 404) return { mode: 'not_found' }

    const requestId = response.headers.get('x-request-id') || ''
    if (!response.ok) {
      return {
        mode: 'unavailable',
        diagnostic: { code: `http_${response.status}`, requestId, at: stamp() },
      }
    }

    const type = response.headers.get('content-type') || ''
    if (!type.includes('application/json')) {
      return {
        mode: 'unavailable',
        diagnostic: { code: 'unexpected_content_type', requestId, at: stamp() },
      }
    }
    const data = await response.json().catch(() => null)
    if (data?.ok) return { mode: 'admin' }
    return {
      mode: 'unavailable',
      diagnostic: { code: 'bad_response', requestId, at: stamp() },
    }
  } catch (error) {
    if (error?.name === 'AbortError') return { mode: 'aborted' }
    return { mode: 'unavailable', diagnostic: { code: 'network_error', requestId: '', at: stamp() } }
  }
}

/**
 * Технические подробности отказа. Код, request ID и время нужны поддержке,
 * но для посетителя это шум, поэтому они спрятаны за <details>.
 */
const Diagnostic = ({ details }) => {
  const text = useLocalizedText(TEXT)
  if (!details) return null

  const rows = [
    details.code ? [text('system.diagnostic.code'), details.code] : null,
    details.requestId ? [text('system.diagnostic.requestId'), details.requestId] : null,
    details.at ? [text('system.diagnostic.time'), details.at] : null,
  ].filter(Boolean)
  if (!rows.length) return null

  return (
    <details>
      <summary>{text('system.diagnostic.summary')}</summary>
      <p className="pv-status__diagnostic">
        {rows.map(([label, value]) => `${label}: ${value}`).join(' · ')}
      </p>
      <p className="pv-status__diagnostic">{text('system.diagnostic.hint')}</p>
    </details>
  )
}

const LoadingShell = ({ textKey = 'system.checking' }) => {
  const text = useLocalizedText(TEXT)
  return (
    <main className="pv-route-shell" aria-busy="true" aria-live="polite">
      <div className="pv-route-shell__card">
        <span className="pv-route-shell__mark" aria-hidden="true" />
        <div className="pv-route-shell__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p>{text(textKey)}</p>
      </div>
    </main>
  )
}

const NotFound = () => {
  const text = useLocalizedText(TEXT)

  useEffect(() => {
    const robots = document.querySelector('meta[name="robots"]')
    const before = robots?.getAttribute('content')
    const node = robots || document.head.appendChild(document.createElement('meta'))
    node.setAttribute('name', 'robots')
    node.setAttribute('content', 'noindex, nofollow')
    return () => {
      if (!robots) node.remove()
      else if (before == null) robots.removeAttribute('content')
      else robots.setAttribute('content', before)
    }
  }, [])

  return (
    <main className="pv-route-shell">
      <div className="pv-route-shell__card">
        <span className="pv-route-shell__code">404</span>
        <h1>{text('system.notFound.title')}</h1>
        <p>{text('system.notFound.text')}</p>
        <a className="pv-btn pv-btn--primary" href="/">
          {text('system.home')}
        </a>
      </div>
    </main>
  )
}

const Unavailable = ({ onRetry, diagnostic }) => {
  const text = useLocalizedText(TEXT)
  return (
    <main className="pv-route-shell">
      <div className="pv-route-shell__card" role="alert">
        <h1>{text('system.unavailable.title')}</h1>
        <p>{text('system.unavailable.text')}</p>
        <button type="button" className="pv-btn pv-btn--primary" onClick={onRetry}>
          {text('system.retry')}
        </button>
        <Diagnostic details={diagnostic} />
      </div>
    </main>
  )
}

const ChunkFailed = ({ diagnostic }) => {
  const text = useLocalizedText(TEXT)
  return (
    <main className="pv-route-shell">
      <div className="pv-route-shell__card" role="alert">
        <h1>{text('system.chunkFailed.title')}</h1>
        <p>{text('system.chunkFailed.text')}</p>
        <button
          type="button"
          className="pv-btn pv-btn--primary"
          onClick={() => window.location.reload()}
        >
          {text('system.reload')}
        </button>
        <Diagnostic details={diagnostic} />
      </div>
    </main>
  )
}

class AdminChunkBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, diagnostic: null }
  }

  static getDerivedStateFromError(error) {
    return {
      failed: true,
      // Имя исключения, а не его текст: в тексте бывает путь к чанку,
      // а он в интерфейсе не нужен даже в блоке диагностики.
      diagnostic: { code: error?.name || 'chunk_load_failed', requestId: '', at: stamp() },
    }
  }

  componentDidCatch(error) {
    console.error('[admin] chunk load failed:', error?.message || 'unknown error')
  }

  render() {
    if (this.state.failed) return <ChunkFailed diagnostic={this.state.diagnostic} />
    return this.props.children
  }
}

const App = () => {
  const isRoot = typeof window === 'undefined' || window.location.pathname === '/'
  const [mode, setMode] = useState(isRoot ? 'site' : 'checking')
  const [diagnostic, setDiagnostic] = useState(null)
  const [probeAttempt, setProbeAttempt] = useState(0)

  useEffect(() => {
    if (mode !== 'checking') return undefined
    const controller = new AbortController()
    probeAdmin(controller.signal).then((result) => {
      if (result.mode === 'aborted') return
      setDiagnostic(result.diagnostic || null)
      setMode(result.mode)
    })
    return () => controller.abort()
  }, [mode, probeAttempt])

  const retry = useCallback(() => {
    setProbeAttempt((value) => value + 1)
    setMode('checking')
  }, [])

  if (mode === 'site') return <Home />
  if (mode === 'not_found') return <NotFound />
  if (mode === 'unavailable') return <Unavailable onRetry={retry} diagnostic={diagnostic} />
  if (mode === 'admin') {
    return (
      <AdminChunkBoundary>
        <Suspense fallback={<LoadingShell textKey="system.loadingPanel" />}>
          <AdminEntry />
        </Suspense>
      </AdminChunkBoundary>
    )
  }
  return <LoadingShell />
}

export default App
