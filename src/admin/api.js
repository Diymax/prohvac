// HTTP-клиент админки. Один на всё приложение: экраны не должны знать
// ни про заголовок CSRF, ни про то, чем ответ сервера отличается от ответа
// прокси, ни про формат ошибок.
//
// ТРИ ОСОБЕННОСТИ, РАДИ КОТОРЫХ ЭТОТ ФАЙЛ ВООБЩЕ СУЩЕСТВУЕТ.
//
// 1. Отсутствие сессии выглядит как обычная страница сайта. Сервер отвечает
//    на любой /api/admin/* без сессии так же, как на неизвестный API:
//    JSON 404 без признаков существования панели. Тип содержимого всё равно
//    проверяется до разбора: прокси может вернуть собственную HTML-страницу.
//
// 2. Мутации требуют X-CSRF-Token. Токен живёт здесь, в модуле, а не в React:
//    его обновляет любой ответ логина и GET /api/admin/session, и протаскивать
//    его пропсами через каждый экран означало бы забыть это сделать ровно
//    в одном месте. Кука сессии HttpOnly, поэтому credentials: 'same-origin'
//    обязателен: без него браузер не пошлёт куку на собственный же origin
//    в старых сборках Safari.
//
// 3. Ошибка — это исключение с полем code. Экранам нужен машинный код
//    ('invalid_credentials', 'rate_limited'), а не текст: тексты у нас разные
//    для разных мест, а иногда намеренно ОДИНАКОВЫЕ для разных кодов
//    (см. screens/Login.jsx).

// Все адреса модуля относительны этого префикса: путь админки секретный
// и в API не участвует — /api/admin/* обслуживается на общем origin.
const BASE = '/api/admin'

// Потолок ожидания ответа. Вход намеренно медленный (сервер выравнивает время
// ответа), медиа грузится дольше — поэтому запас большой, но не бесконечный:
// висящий запрос без ответа должен превращаться в понятную ошибку.
const DEFAULT_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 120_000

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Ошибка запроса к админскому API.
 *
 * code — машинный код: либо error из тела ответа, либо один из собственных
 * ('network', 'timeout', 'not_found', 'bad_response').
 */
export class ApiError extends Error {
  constructor(code, options = {}) {
    super(options.message || code)
    this.name = 'ApiError'
    this.code = code
    this.status = options.status ?? 0
    this.payload = options.payload ?? null
    this.requestId = options.requestId ?? ''
    // Сервер сообщает, через сколько секунд можно повторить (429).
    this.retryAfterSec = options.payload?.retryAfterSec ?? null
  }
}

// ---------------------------------------------------------------------------
// Состояние клиента
// ---------------------------------------------------------------------------

let csrfToken = ''
// Номер поколения токена. Растёт на каждой записи и нужен вызывающему,
// чтобы отличить «токен тот же самый» от «токен успели заменить, пока шёл
// мой запрос»: сервер ротирует его на входе, втором факторе и смене пароля.
let csrfGeneration = 0
let onSessionLost = null
// Выброс объявляется один раз. Экранов, которые параллельно дёргают API,
// в панели несколько, и каждый из них получает на просроченной куке один
// и тот же ответ: без этой защёлки «сессия завершилась» показывалось бы
// столько раз, сколько запросов оказалось в полёте.
let sessionLostFired = false

/**
 * Запоминает CSRF-токен. Вызывается из useSession на каждый ответ, где он есть.
 *
 * @param {string} token
 * @returns {number} поколение токена после записи
 */
export const setCsrfToken = (token) => {
  csrfToken = typeof token === 'string' ? token : ''
  csrfGeneration += 1
  // Непустой токен означает живую сессию: следующий её выброс снова должен
  // дойти до интерфейса.
  if (csrfToken) sessionLostFired = false
  return csrfGeneration
}

export const getCsrfToken = () => csrfToken

export const getCsrfGeneration = () => csrfGeneration

/**
 * Обработчик пропавшей сессии. Сюда приходит любой ответ, который сервер
 * маскирует под несуществующий адрес: сессия истекла, отозвана с другого
 * устройства или её не было вовсе. Реакция ровно одна — показать экран входа,
 * поэтому обработчик один и глобальный (его ставит useSession).
 *
 * @param {Function|null} handler
 * @returns {() => void} снятие подписки; чужой обработчик оно не трогает,
 *   иначе размонтирование старого экземпляра хука обнуляло бы новый
 */
export const setSessionLostHandler = (handler) => {
  const next = typeof handler === 'function' ? handler : null
  onSessionLost = next
  sessionLostFired = false

  return () => {
    if (onSessionLost !== next) return
    onSessionLost = null
    sessionLostFired = false
  }
}

const notifySessionLost = (error) => {
  if (!onSessionLost || sessionLostFired) return
  sessionLostFired = true
  onSessionLost(error)
}

const isJsonResponse = (response) => {
  const type = response.headers.get('content-type') || ''
  return type.split(';')[0].trim().toLowerCase() === 'application/json'
}

/**
 * Абортирует запрос по таймауту и по внешнему сигналу.
 * AbortSignal.any() решил бы это одной строкой, но он появился только
 * в браузерах 2024 года, а админкой пользуются с того, что стоит на телефоне.
 */
const withTimeout = (timeoutMs, external) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new ApiError('timeout')), timeoutMs)

  const forward = () => controller.abort(external.reason)
  if (external) {
    if (external.aborted) forward()
    else external.addEventListener('abort', forward, { once: true })
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', forward)
    },
    timedOut: () => controller.signal.reason instanceof ApiError,
  }
}

/**
 * Запрос к админскому API.
 *
 * @param {string} method
 * @param {string} path путь относительно /api/admin, например '/session'
 * @param {{body?: object|FormData, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<object>} тело ответа (всегда с ok: true)
 * @throws {ApiError}
 */
export const request = async (method, path, options = {}) => {
  const { body, timeoutMs, signal } = options
  const upload = body instanceof FormData

  const headers = { Accept: 'application/json' }
  let payload

  if (upload) {
    // Content-Type для multipart ставит сам браузер: в нём boundary,
    // которого мы не знаем, и заданный руками заголовок ломает разбор.
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  // На безопасных методах заголовка нет: verifyCsrf их не проверяет,
  // а лишний заголовок в GET — это лишний повод для preflight.
  if (!SAFE_METHODS.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken

  const timeout = withTimeout(timeoutMs ?? (upload ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS), signal)

  // Путь принимается в двух видах: короткий ('/session') и полный
  // ('/api/admin/session'). Экраны писались независимо от этого клиента
  // и используют полный, а useSession — короткий. Без нормализации полный
  // путь склеивался бы с BASE в '/api/admin/api/admin/session', и почти
  // вся панель молча стучалась бы в несуществующие адреса.
  const url = path.startsWith(BASE) ? path : `${BASE}${path}`

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload,
      // Кука сессии — __Host-, HttpOnly. Без credentials её не будет.
      credentials: 'same-origin',
      // Ответы админки помечены no-store, но промежуточный кэш браузера
      // всё равно не должен даже пытаться их переиспользовать.
      cache: 'no-store',
      redirect: 'error',
      signal: timeout.signal,
    })
  } catch (error) {
    if (timeout.timedOut()) throw new ApiError('timeout', { message: 'превышено время ожидания' })
    // Внешняя отмена (ушли с экрана) — не ошибка сети, пусть вызывающий
    // отличит её по имени и просто ничего не показывает.
    if (error?.name === 'AbortError') throw error
    throw new ApiError('network', { message: error?.message })
  } finally {
    timeout.done()
  }

  // HTML вместо JSON — это uniform404, см. шапку файла.
  if (!isJsonResponse(response)) {
    const error = new ApiError('not_found', {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
    })
    notifySessionLost(error)
    throw error
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    throw new ApiError('bad_response', {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
    })
  }

  if (!data || typeof data !== 'object') {
    throw new ApiError('bad_response', {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
    })
  }

  if (data.ok === false || !response.ok) {
    const code = typeof data.error === 'string' ? data.error : `http_${response.status}`
    const error = new ApiError(code, {
      status: response.status,
      payload: data,
      requestId: response.headers.get('x-request-id') || data.requestId || '',
    })
    // Отозванная кука и просроченный CSRF означают одно и то же для интерфейса:
    // дальше работать нечем, нужен вход заново.
    if (code === 'no_session' || code === 'not_found') notifySessionLost(error)
    throw error
  }

  return data
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  del: (path, options) => request('DELETE', path, options),
  /**
   * Загрузка файла. Тело — FormData, поэтому заголовки собираются иначе,
   * а ждать ответа можно дольше: сервер считает хеш и размеры картинки.
   */
  upload: (path, formData, options) => request('POST', path, { ...options, body: formData }),
}
