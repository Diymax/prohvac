// Маскировка админки: гейт по секретному пути.
//
// ПРОТИВОРЕЧИЕ В ТРЕБОВАНИЯХ. Заказчик попросил одновременно две вещи: чтобы
// админка открывалась по привычному /admin и чтобы её нельзя было найти.
// Вместе это невозможно: как только /admin отдаёт форму входа, сканеру
// достаточно одного запроса, чтобы узнать о существовании панели, а дальше он
// перебирает пароли — то есть весь «секретный путь» ничего не защищает.
//
// Поэтому режимов два, и переключаются они конфигом:
//
//   1. Секретный путь (ADMIN_SECRET_PATH). Знание самого пути и есть пропуск
//      к форме входа. Ответ на любой другой адрес неотличим от фона.
//   2. Легаси-путь /admin (ADMIN_LEGACY_PATH_ENABLED). Работает только после
//      того, как клиент уже прошёл по секретному пути и получил gate-куку.
//      То есть /admin удобен человеку, который однажды открыл настоящий адрес
//      в этом браузере, и невидим для всех остальных.
//
// ЧТО ТАКОЕ GATE-КУКА И ЧЕМ ОНА НЕ ЯВЛЯЕТСЯ. Кука '__Host-pv_g' — НЕ
// аутентификация. Она не содержит пользователя, не даёт никаких прав и сама
// по себе не пускает ни к одному действию: за это отвечают сессия
// (server/auth/session.js), пароль и второй фактор. Единственный её эффект —
// снять маскировку, то есть разрешить серверу признать, что админка вообще
// существует. Украденная gate-кука не даёт атакующему ничего, кроме знания
// о наличии панели, — примерно того же, что даёт и угаданный секретный путь.
//
// ОТКАЗ ОБЯЗАН БЫТЬ НЕОТЛИЧИМ ОТ ФОНА. Когда shouldRevealAdmin() вернул false,
// вызывающий отдаёт ровно тот же uniform404, что и на несуществующий путь
// (см. комментарий в server/http/respond.js). Любая разница — код ответа,
// длина тела, набор заголовков, время ответа — превращает секретный путь
// в оракул: сканер перебирает варианты и смотрит, где ответ отличается.
// Кэшировать такие ответы тоже нельзя, иначе прокси отдаст замаскированный
// вариант тому, у кого кука есть; sendSpa и json ставят no-store сами.

import { createHmac, timingSafeEqual } from 'node:crypto'

import { config } from '../config.js'
import { parseCookies, serializeCookie } from '../http/cookies.js'

// Префикс __Host- запрещает браузеру принять такую куку с http, без Path=/
// и с чужого поддомена. Имя короткое и невыразительное намеренно: длинное
// 'pv_admin_gate' в заголовке Cookie само сообщает, что у сайта есть админка.
export const GATE_COOKIE = '__Host-pv_g'

// 30 минут. Кука живёт ровно столько, сколько длится сеанс работы в панели:
// снятая маскировка не должна оставаться на месяцы в браузере, который потом
// одолжили или унесли из офиса. Продлевается на каждом заходе по секретному
// пути, поэтому работать она не мешает.
export const GATE_TTL_MS = 30 * 60_000

// Первый сегмент легаси-пути. Ровно 'admin', без вариантов вроде 'admin-panel':
// список «похожих» адресов — это ещё один способ случайно оставить открытой
// дверь, о которой забыли.
export const LEGACY_ADMIN_SEGMENT = 'admin'

// Потолок на длину значения куки. Разбор дешёвый, но HMAC от мегабайтной
// строки на каждом запросе сканера — уже бесплатная нагрузка на процессор.
const MAX_VALUE_LENGTH = 256

// base64url от 32 байт HMAC-SHA256 — всегда 43 символа без padding.
const SIG_LENGTH = 43

/**
 * Сравнение строк за постоянное время. Длины сравниваются обычным способом:
 * скрыть их всё равно нельзя, а секрета в них нет (длина подписи фиксирована,
 * длина ADMIN_SECRET_PATH видна по любому запросу).
 */
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  // timingSafeEqual на буферах разной длины бросает, поэтому проверка до него —
  // не оптимизация, а условие работоспособности.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Подпись полезной нагрузки. Подписывается ИМЕННО тот текст, который уедет
 * в куку (base64url), а не число до кодирования: подписав одно, а проверив
 * другое, легко получить расхождение канонизации — классический источник
 * обхода подписи.
 */
const sign = (payload, secret) =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')

/**
 * Дописывает Set-Cookie, не затирая уже выставленные. res.setHeader заменяет
 * значение целиком, и прямая запись стёрла бы куку сессии, если её поставили
 * в этом же ответе.
 */
const appendSetCookie = (res, cookie) => {
  if (!res || res.headersSent || res.writableEnded || typeof res.setHeader !== 'function') {
    return false
  }

  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null
  const list = existing == null ? [] : Array.isArray(existing) ? existing : [String(existing)]

  res.setHeader('Set-Cookie', [...list, cookie])
  return true
}

/**
 * Ставит gate-куку и возвращает собранное значение заголовка.
 *
 * ЕЩЁ РАЗ: эта кука НЕ является аутентификацией и не даёт никаких прав.
 * Она только снимает маскировку админки (см. шапку модуля). Всё, что делает
 * что-то опасное, обязано проверять сессию, а не её.
 *
 * Значение: base64url(срок в мс) + '.' + HMAC-SHA256(та же строка, GATE_SECRET).
 * Срок лежит внутри подписанного значения, а не только в Max-Age: Max-Age —
 * это просьба к браузеру, и клиент, который её игнорирует (или просто
 * скопировал куку), не должен получить бессрочный пропуск.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{now?: number, ttlMs?: number, secret?: string}} [options]
 * @returns {string} значение заголовка Set-Cookie
 */
export const issueGateCookie = (res, options = {}) => {
  const { now = Date.now(), ttlMs = GATE_TTL_MS, secret = config.gateSecret } = options

  if (typeof secret !== 'string' || !secret) {
    // Пустой ключ означает подпись, которую воспроизведёт любой, кто читал
    // этот файл. Падаем громко: в проде до сюда не дойдёт (см.
    // assertProductionConfig), а в тестах и утилитах молчаливая заглушка
    // была бы хуже ошибки.
    throw new Error('gate: GATE_SECRET пуст — подписывать куку нечем')
  }
  if (!Number.isInteger(now) || !Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`gate: некорректный срок жизни куки (now=${now}, ttlMs=${ttlMs})`)
  }

  const payload = Buffer.from(String(now + ttlMs), 'utf8').toString('base64url')
  const value = `${payload}.${sign(payload, secret)}`

  const cookie = serializeCookie(GATE_COOKIE, value, {
    path: '/',
    httpOnly: true,
    secure: true,
    // Strict, а не Lax: по внешней ссылке в админку не приходят, а Lax отдал бы
    // куку при переходе с чужого сайта, то есть снял бы маскировку по чужой
    // наводке.
    sameSite: 'strict',
    maxAge: Math.floor(ttlMs / 1000),
  })

  appendSetCookie(res, cookie)
  return cookie
}

/**
 * Проверяет gate-куку запроса: подпись нашим ключом и незакончившийся срок.
 *
 * Отказ всегда тихий — false, без исключений: сюда приходит значение прямо
 * из заголовка клиента, и любой мусор в нём не должен превращаться в 500,
 * потому что 500 на одном адресе и оболочка на другом — это та самая
 * различимость ответов, ради устранения которой всё и затевалось.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{now?: number, secret?: string}} [options]
 * @returns {boolean}
 */
export const verifyGateCookie = (req, options = {}) => {
  const { now = Date.now(), secret = config.gateSecret } = options

  // Без ключа проверять нечем. Отвечаем «куки нет»: маскировка остаётся
  // включённой, то есть сбой конфигурации закрывает админку, а не открывает.
  if (typeof secret !== 'string' || !secret) return false

  const raw = parseCookies(req)[GATE_COOKIE]
  if (typeof raw !== 'string' || !raw || raw.length > MAX_VALUE_LENGTH) return false

  const dot = raw.indexOf('.')
  // dot < 1 — пустая полезная нагрузка; второй разделитель означает не наш
  // формат, и разбирать такое дальше незачем.
  if (dot < 1 || raw.indexOf('.', dot + 1) !== -1) return false

  const payload = raw.slice(0, dot)
  const provided = raw.slice(dot + 1)
  if (provided.length !== SIG_LENGTH) return false

  // Подпись сначала: срок — это данные, которым до проверки подписи верить
  // нельзя. Сравнение timingSafeEqual, потому что обычное '===' выходит
  // на первом несовпавшем символе и позволяет подбирать подпись по времени.
  if (!safeEqual(provided, sign(payload, secret))) return false

  const exp = Number(Buffer.from(payload, 'base64url').toString('utf8'))
  // Number.isSafeInteger отсекает и NaN, и дробное, и Infinity — то есть всё,
  // с чем сравнение '>' дало бы неожиданный результат.
  return Number.isSafeInteger(exp) && exp > now
}

/** Первый сегмент нормализованного пути ('/a/b' -> 'a'). Пустая строка для '/'
 *  и для всего, что нормализацию в server/app.js не проходило. */
const firstSegment = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return ''
  const rest = path.slice(1)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

/**
 * Относится ли путь к админке и каким из двух способов в неё зашли.
 *
 * Путь ожидается уже нормализованным (normalizePath в server/app.js): без
 * query, без повторных слэшей, декодированный ровно один раз. Второй
 * реализации тех же правил здесь нет намеренно — разойдясь, они дали бы дыру.
 *
 * @param {string} path
 * @param {typeof config} [cfg]
 * @returns {{isAdmin: boolean, isSecretEntry: boolean}}
 *   isSecretEntry — вход по секретному пути, то есть клиент уже доказал знание
 *   ADMIN_SECRET_PATH. Именно таким запросам выдаётся gate-кука.
 */
export const isAdminPath = (path, cfg = config) => {
  const segment = firstSegment(path)
  if (!segment) return { isAdmin: false, isSecretEntry: false }

  const secret = typeof cfg?.adminSecretPath === 'string' ? cfg.adminSecretPath : ''
  // Пустой секретный путь не должен совпадать ни с чем: иначе битая
  // конфигурация открыла бы админку по произвольному адресу.
  if (secret && safeEqual(segment, secret)) return { isAdmin: true, isSecretEntry: true }

  // Легаси-путь существует, только пока он явно включён. Проверка флага стоит
  // до сравнения строки, чтобы выключенный /admin вообще не считался
  // админским и уходил в общий конвейер как любой неизвестный адрес.
  if (cfg?.adminLegacyPathEnabled && segment === LEGACY_ADMIN_SEGMENT) {
    return { isAdmin: true, isSecretEntry: false }
  }

  return { isAdmin: false, isSecretEntry: false }
}

/**
 * Можно ли признать существование админки в ответе на этот запрос.
 *
 * false означает: вызывающий ОБЯЗАН отдать uniform404 — тот же самый ответ,
 * что и на несуществующий путь. Разница в ответе свела бы на нет весь смысл
 * секретного пути (см. шапку модуля).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {typeof config} [cfg]
 * @param {{isSecretEntry?: boolean}} [context] запрос пришёл по секретному
 *   пути — знание пути и есть пропуск, куки на первом заходе ещё нет.
 *   Значение берётся из isAdminPath(); проще всего не считать его руками,
 *   а вызвать enterAdminGate().
 * @returns {boolean}
 */
export const shouldRevealAdmin = (req, cfg = config, context = {}) => {
  // Гейт выключен (по умолчанию так вне прода) — маскировать нечего.
  if (!cfg?.adminRequireGate) return true

  if (context?.isSecretEntry) return true

  return verifyGateCookie(req, { secret: cfg?.gateSecret ?? config.gateSecret })
}

/**
 * Единая точка для server/app.js: разбирает путь, при заходе по секретному
 * адресу выдаёт (и продлевает) gate-куку и говорит, показывать админку или
 * отдавать uniform404.
 *
 * Функция существует ради одной ловушки: на первом заходе по секретному пути
 * куки ещё нет, и проверка «нет куки — маскируем» закрыла бы админку навсегда.
 * Порядок «сначала выдать, потом проверять» легко потерять, собирая эти вызовы
 * вручную в конвейере, поэтому он зафиксирован здесь.
 *
 * @returns {{isAdmin: boolean, isSecretEntry: boolean, reveal: boolean}}
 */
export const enterAdminGate = (req, res, path, cfg = config) => {
  const { isAdmin, isSecretEntry } = isAdminPath(path, cfg)
  if (!isAdmin) return { isAdmin: false, isSecretEntry: false, reveal: false }

  if (isSecretEntry && cfg?.adminRequireGate) {
    // Кука выдаётся на каждом заходе по секретному пути, а не только на первом:
    // так окно в 30 минут скользит вместе с работой в панели и не обрывает
    // сеанс на середине.
    issueGateCookie(res, { secret: cfg?.gateSecret ?? config.gateSecret })
  }

  return { isAdmin, isSecretEntry, reveal: shouldRevealAdmin(req, cfg, { isSecretEntry }) }
}
