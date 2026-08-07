// Единственная точка сборки HTTP-ответов. Смысл в том, чтобы набор
// security-заголовков нельзя было забыть на отдельном маршруте: под Passenger
// нет промежуточного слоя вроде helmet, и «защита есть почти везде» —
// это защита, которой нет.
//
// Модуль не знает ни про маршруты, ни про бизнес-логику: он только пишет
// в ServerResponse.

import { config } from '../config.js'

// Отключаем всё, чем лендинг не пользуется: даже если на страницу попадёт
// чужой скрипт, доступ к камере, микрофону и геолокации ему не выдадут.
// interest-cohort оставлен ради сборок Chrome с FLoC — лишняя директива
// не стоит ничего, а её отсутствие когда-то означало согласие.
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
  'interest-cohort=()',
].join(', ')

/**
 * Собирает Strict-Transport-Security из настроек.
 *
 * Директивы разделены намеренно. includeSubDomains связывает политикой все
 * поддомены апекса разом — включая чужие сервисы и внутренние стенды, о
 * которых этот сервер ничего не знает, — а preload вносит домен в список,
 * зашитый в сборки браузеров. Отменить и то и другое задним числом у уже
 * побывавших на сайте посетителей нельзя, поэтому обе выключены, пока
 * оператор не включит их явно (см. server/config.js).
 */
export const buildHsts = ({ maxAge, includeSubDomains, preload }) => {
  const directives = [`max-age=${maxAge}`]
  if (includeSubDomains) directives.push('includeSubDomains')
  if (preload) directives.push('preload')
  return directives.join('; ')
}

const HSTS = buildHsts(config.hsts)

/**
 * Заголовки уже отправлены или ответ закрыт — писать нечего.
 * Без этой проверки setHeader бросает ERR_HTTP_HEADERS_SENT и роняет запрос
 * в необработанное исключение вместо того, чтобы просто ничего не сделать.
 */
const canWrite = (res) => Boolean(res) && !res.headersSent && !res.writableEnded

/** HEAD обязан отдавать те же заголовки, что и GET, но без тела. */
const isHead = (res) => res.req?.method === 'HEAD'

/**
 * Базовый набор заголовков безопасности. Ставится на КАЖДЫЙ ответ, включая
 * ошибки и 304: страница с ошибкой точно так же живёт в origin сайта.
 */
export const securityHeaders = (res) => {
  if (!canWrite(res)) return

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY)

  // Изоляция браузерного контекста: окно, открытое с нашей страницы, теряет
  // ссылку window.opener, а наши ресурсы нельзя подгрузить с чужого origin.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

  // HSTS только в проде. По http браузер заголовок и так игнорирует, но при
  // локальной разработке через https-туннель он пришпилил бы localhost
  // ко всем портам сразу и сломал бы соседние проекты на много месяцев.
  if (config.isProduction) res.setHeader('Strict-Transport-Security', HSTS)

  // Server и X-Powered-By не ставим никогда: версия рантайма — это бесплатная
  // подсказка сканеру, какие CVE пробовать. removeHeader на случай, если
  // значение проставил слой выше (Node их не ставит, Passenger может).
  res.removeHeader('Server')
  res.removeHeader('X-Powered-By')
}

/** JSON-ответ фиксированного вида: статус, security-заголовки, тело. */
export const json = (res, status, payload) => {
  if (!canWrite(res)) return

  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')

  securityHeaders(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  // Ответы API завязаны на сессию и на состояние базы: закэшированный прокси
  // отдал бы чужой ответ следующему клиенту.
  res.setHeader('Cache-Control', 'no-store')

  res.end(isHead(res) ? undefined : body)
}

/** Ответ без тела: 204 после успешной мутации, 205, preflight-OPTIONS. */
export const noContent = (res, status = 204) => {
  if (!canWrite(res)) return

  securityHeaders(res)
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  // Content-Length у 204/304 не ставим: некоторые прокси считают такой ответ
  // битым и обрывают keep-alive-соединение.
  res.end()
}

/**
 * Ответ на запрос с чужим Host / :authority.
 *
 * Отдельный статус здесь ничего не выдаёт: имя хоста атакующий и так знает —
 * он его сам и прислал, — а маскировать нечего, потому что до маршрутизации
 * дело не дошло и о существовании путей ответ не сообщает. Оболочку SPA
 * не отдаём сознательно: именно её и хочет получить DNS rebinding, чтобы
 * страница выполнилась в origin подставленного имени.
 *
 * 421, а не 400: запрос синтаксически исправен, просто адресован не сюда.
 */
export const misdirected = (res) => {
  if (!canWrite(res)) return

  const body = Buffer.from('Misdirected Request', 'utf8')

  securityHeaders(res)
  res.statusCode = 421
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  res.setHeader('Cache-Control', 'no-store')

  res.end(isHead(res) ? undefined : body)
}

let cachedSendSpa = null

/**
 * spa.js подгружается лениво: ему нужен securityHeaders отсюда, а нам — его
 * sendSpa. Два статических импорта навстречу друг другу дают цикл, в котором
 * порядок инициализации зависит от того, какой модуль загрузили первым.
 * Динамический импорт разрывает цикл, а кэш загрузчика ESM делает все вызовы
 * после первого бесплатными.
 */
const spaSender = async () => {
  if (!cachedSendSpa) ({ sendSpa: cachedSendSpa } = await import('./spa.js'))
  return cachedSendSpa
}

/**
 * Единый ответ на всё, чего клиенту знать не положено.
 *
 * Через эту функцию проходят три разных ситуации:
 *   - запрошен несуществующий URL;
 *   - запрошен /admin (или другой предсказуемый путь) без доступа;
 *   - запрошен /api/admin/* без действующей сессии.
 *
 * Все три обязаны быть НЕОТЛИЧИМЫ друг от друга и от публичного 404:
 * тот же статус 404, та же SPA-оболочка и тот же клиентский Not Found screen.
 * Стоит ответить на закрытую админку 401, 403 или хотя бы 404 с другим телом —
 * и сканеру больше не нужно угадывать ADMIN_SECRET_PATH целиком: он перебирает
 * префиксы и смотрит, где ответ отличается от фонового. Ровно так секретный
 * путь перестаёт быть секретом, а вся защита админки держится именно на нём.
 *
 * Отсюда же требование к nonce в spa.js: он фиксированной длины, поэтому
 * Content-Length у всех таких ответов совпадает до байта.
 */
export const uniform404 = async (req, res) => {
  const sendSpa = await spaSender()
  await sendSpa(req, res, 404)
}

/**
 * Промах по маршруту внутри /api/*. Здесь SPA-оболочка бессмысленна: клиент
 * ждёт JSON, и HTML он всё равно не разберёт. Форма ответа ровно та же, что
 * у остальных ошибок API, — {ok:false, error}.
 *
 * Пути админского API сюда не попадают: они обслуживаются uniform404,
 * чтобы не отличаться от фона (см. комментарий выше).
 */
export const apiNotFound = (res) => {
  json(res, 404, { ok: false, error: 'not_found' })
}
