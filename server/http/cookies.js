// Разбор заголовка Cookie и сборка Set-Cookie без зависимостей (RFC 6265).
// Модуль намеренно строгий: в куках лежат сессия и CSRF-токен, поэтому любое
// нарушение инварианта здесь должно падать при разработке, а не молча
// превращаться в куку, которую браузер выбросит или позволит подменить.

// Разрешённые символы имени куки — token из RFC 7230. Всё остальное (пробел,
// точка с запятой, запятая, управляющие символы) позволяет разорвать заголовок
// и дописать чужие атрибуты.
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Символы, которыми можно вырваться из значения Path/Domain в соседний
// атрибут (';' и ',') или в соседний заголовок (CR/LF и прочие control chars).
// Дефис и точка допустимы — без них не записать ни sub-domain, ни путь.
// eslint-disable-next-line no-control-regex
const ATTR_FORBIDDEN = /[;,\s\u0000-\u001F\u007F]/

const SAME_SITE = new Map([
  ['lax', 'Lax'],
  ['strict', 'Strict'],
  ['none', 'None'],
])

/**
 * Значение куки в заголовке может быть в кавычках (quoted-string) — снимаем их
 * перед декодированием, иначе кавычки утекут в прикладной код.
 */
const unquote = (value) =>
  value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value

/**
 * Заголовок Cookie приходит от клиента, поэтому битый percent-encoding — не
 * ошибка сервера: decodeURIComponent('%zz') бросает URIError и уронил бы
 * запрос в 500. Возвращаем сырую строку.
 */
const safeDecode = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Разбирает заголовок Cookie запроса в простой объект { имя: значение }.
 * При дубликатах имени выигрывает первое вхождение: браузер ставит вперёд куку
 * с более специфичным Path, и именно её мы должны видеть.
 */
export const parseCookies = (req) => {
  const raw = req?.headers?.cookie
  // Node склеивает повторяющиеся Cookie-заголовки в массив — редко, но бывает
  // за нестандартным прокси, и тогда обращение к .split() упало бы.
  const header = Array.isArray(raw) ? raw.join('; ') : raw

  // Object.create(null): в куку легко положить имя '__proto__' или 'constructor',
  // и на обычном литерале обращение к ним вернуло бы прототип вместо undefined.
  const out = Object.create(null)
  if (typeof header !== 'string' || !header) return out

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    // eq === 0 — пустое имя, eq < 0 — кусок без значения: и то и другое мусор.
    if (eq < 1) continue

    const name = part.slice(0, eq).trim()
    if (!name || name in out) continue

    out[name] = safeDecode(unquote(part.slice(eq + 1).trim()))
  }

  return out
}

/**
 * Собирает значение заголовка Set-Cookie.
 *
 * Опции: maxAge, expires, path, domain, secure, httpOnly, sameSite.
 * Бросает Error на любой комбинации, которую браузер отверг бы или исполнил
 * не так, как ожидает вызывающий код.
 */
export const serializeCookie = (name, value, opts = {}) => {
  if (typeof name !== 'string' || !TOKEN_PATTERN.test(name)) {
    throw new Error(`cookie: недопустимое имя ${JSON.stringify(name)}`)
  }

  const { maxAge, expires, path, domain, secure = false, httpOnly = false, sameSite } = opts

  // Префикс __Host- — единственная защита от подстановки куки с соседнего
  // поддомена: evil.example.com не сможет перезаписать куку example.com.
  // Браузер просто игнорирует Set-Cookie с нарушенными инвариантами, так что
  // тихая поломка выглядела бы как случайный разлогин, а не как ошибка кода.
  if (name.startsWith('__Host-')) {
    if (!secure) throw new Error('cookie: __Host- требует Secure')
    if (path !== '/') throw new Error("cookie: __Host- требует Path='/'")
    if (domain != null) throw new Error('cookie: __Host- запрещает Domain')
  }

  // Младший брат __Host-: гарантирует, что куку выставили по HTTPS,
  // то есть её не подсадил сетевой посредник по http://.
  if (name.startsWith('__Secure-') && !secure) {
    throw new Error('cookie: __Secure- требует Secure')
  }

  const parts = [`${name}=${encodeURIComponent(String(value ?? ''))}`]

  if (maxAge != null) {
    // Дробный Max-Age браузеры трактуют по-разному вплоть до немедленного
    // удаления куки, поэтому это проверка корректности, а не придирка.
    if (!Number.isInteger(maxAge)) {
      throw new Error('cookie: Max-Age должен быть целым числом секунд')
    }
    parts.push(`Max-Age=${maxAge}`)
  }

  if (expires != null) {
    const date = expires instanceof Date ? expires : new Date(expires)
    if (Number.isNaN(date.getTime())) throw new Error('cookie: некорректный Expires')
    parts.push(`Expires=${date.toUTCString()}`)
  }

  if (path != null) {
    if (typeof path !== 'string' || ATTR_FORBIDDEN.test(path)) {
      throw new Error('cookie: недопустимый Path')
    }
    parts.push(`Path=${path}`)
  }

  if (domain != null) {
    if (typeof domain !== 'string' || ATTR_FORBIDDEN.test(domain)) {
      throw new Error('cookie: недопустимый Domain')
    }
    parts.push(`Domain=${domain}`)
  }

  if (sameSite != null) {
    const normalized = SAME_SITE.get(String(sameSite).toLowerCase())
    if (!normalized) throw new Error(`cookie: недопустимый SameSite ${JSON.stringify(sameSite)}`)
    // SameSite=None без Secure современный браузер отбрасывает целиком —
    // ровно тот случай, когда «работает локально, ломается в проде».
    if (normalized === 'None' && !secure) {
      throw new Error('cookie: SameSite=None требует Secure')
    }
    parts.push(`SameSite=${normalized}`)
  }

  if (secure) parts.push('Secure')
  if (httpOnly) parts.push('HttpOnly')

  return parts.join('; ')
}
