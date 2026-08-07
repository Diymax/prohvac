// Защита от межсайтовой подделки запросов для всего, что меняет состояние
// в /api/admin/*.
//
// Барьеров три, и они намеренно независимы: каждый закрывает то, что
// пропускают остальные, и обход требует пробить все сразу.
//
//   1. Origin. Отсекает форму и fetch с чужого домена: браузер ставит этот
//      заголовок на любой не-GET сам, и подделать его из страницы нельзя.
//      Слабое место — клиенты и прокси, которые Origin вырезают.
//   2. Токен сессии в заголовке X-CSRF-Token. Работает даже там, где Origin
//      потерялся: чужая страница не может прочитать токен, потому что
//      его отдаёт только наш же ответ на наш же домен.
//   3. Content-Type: application/json. HTML-форма умеет ровно три типа
//      (urlencoded, multipart, text/plain), поставить application/json ей
//      нечем — для этого нужен fetch/XHR, а он на кросс-домене упрётся
//      в preflight, который мы не разрешаем.
//
// Кука сессии выставлена с SameSite=Strict, то есть формально это четвёртый
// барьер. Полагаться на него одного нельзя: SameSite — политика браузера,
// а не проверка сервера, и она не спасает от запроса с нашего же поддомена.

import { createHash, timingSafeEqual } from 'node:crypto'

export const CSRF_HEADER = 'x-csrf-token'

// Максимальная длина принимаемого токена. Настоящий — 43 символа base64url;
// запас нужен на случай смены длины, а потолок — чтобы не считать sha256
// от мегабайтного заголовка на каждой попытке подбора.
const MAX_TOKEN_LENGTH = 512

const CSRF_HASH_PATTERN = /^[0-9a-f]{64}$/

const DEFAULT_CONTENT_TYPES = Object.freeze(['application/json'])

// Методы без побочных эффектов по RFC 9110. Проверять их бессмысленно: если
// GET что-то меняет, проблема не в CSRF-токене, а в самом эндпоинте.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Нужна ли проверка для этого метода. Вынесено сюда, чтобы у роутера
 *  и у проверки был один и тот же список, а не две расходящиеся копии. */
export const isSafeMethod = (method) => SAFE_METHODS.has(String(method ?? '').toUpperCase())

/**
 * Значение заголовка. Дубликат заголовка Node отдаёт массивом (или склеивает
 * через запятую) — это не бывает у честного браузера, зато так выглядит
 * попытка протащить второй Origin мимо прокси. Считаем такое отсутствием
 * значения, то есть отказом.
 */
const headerValue = (req, name) => {
  const value = req?.headers?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

/** Барьер 1: запрос пришёл с нашего же источника. */
const checkOrigin = (req, publicOrigin) => {
  const origin = headerValue(req, 'origin').toLowerCase()

  if (origin) {
    // Строгое равенство целиком: схема, домен и порт. Сравнение по
    // «заканчивается на prohvac.uz» ловится доменом prohvac.uz.evil.com,
    // а по «содержит» — вообще чем угодно.
    // Значение 'null' (песочница iframe, редирект со сменой схемы) сюда
    // тоже не пройдёт, и это правильно.
    return origin === publicOrigin
      ? { ok: true }
      : { ok: false, error: 'origin_mismatch' }
  }

  // Origin нет — пробуем метаданные Fetch. same-site недостаточно: это
  // соседний поддомен, а он в нашей модели угроз не доверенный.
  const site = headerValue(req, 'sec-fetch-site').toLowerCase()
  if (site) {
    return site === 'same-origin' ? { ok: true } : { ok: false, error: 'cross_site' }
  }

  // Ни того, ни другого. Это либо очень старый браузер, либо curl, либо
  // запрос, у которого заголовки по дороге вычистили. Пропускать нельзя:
  // именно на этой ветке держится весь барьер.
  return { ok: false, error: 'origin_missing' }
}

/** Барьер 2: заголовок совпадает с токеном, выданным этой сессии. */
const checkToken = (req, session) => {
  const expectedHash = session?.csrf_hash
  // Строка сессии без валидного хеша — это либо не сессия, либо повреждённая
  // запись. И то и другое трактуем как отказ, а не как «проверять нечего».
  if (typeof expectedHash !== 'string' || !CSRF_HASH_PATTERN.test(expectedHash)) {
    return { ok: false, error: 'no_session' }
  }

  const provided = headerValue(req, CSRF_HEADER)
  if (!provided || provided.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: 'csrf_missing' }
  }

  // В базе лежит только хеш, поэтому сравниваем хеш с хешем. Само сравнение —
  // timingSafeEqual: обычное '===' выходит на первом несовпавшем байте, и по
  // времени ответа хеш подбирается побайтно. Оба буфера ровно 32 байта,
  // поэтому падения из-за разной длины здесь быть не может.
  const actual = createHash('sha256').update(provided, 'utf8').digest()
  const expected = Buffer.from(expectedHash, 'hex')

  return timingSafeEqual(actual, expected) ? { ok: true } : { ok: false, error: 'csrf_invalid' }
}

/** Барьер 3: тело именно того типа, который простой формой не отправить. */
const checkContentType = (req, contentTypes) => {
  if (contentTypes == null) return { ok: true }

  // Отрезаем параметры: приходит 'application/json; charset=utf-8'.
  const actual = headerValue(req, 'content-type').split(';')[0].trim().toLowerCase()
  return contentTypes.includes(actual)
    ? { ok: true }
    : { ok: false, error: 'unsupported_media_type' }
}

/**
 * Проверяет запрос по всем трём барьерам. Вызывать для любого небезопасного
 * метода до того, как прочитано тело и что-либо изменено.
 *
 * @param {object} req входящий запрос node:http
 * @param {object} session строка сессии из loadSession (нужен csrf_hash)
 * @param {{publicOrigin: string, contentTypes?: string[]|null}} config
 *   publicOrigin — обязателен, обычно config.publicOrigin целиком.
 *   contentTypes — список допустимых типов тела; null отключает барьер 3
 *   там, где он неприменим (загрузка файла идёт multipart/form-data).
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export const verifyCsrf = (req, session, config = {}) => {
  const { publicOrigin, contentTypes = DEFAULT_CONTENT_TYPES } = config

  // Без известного собственного источника сравнивать Origin не с чем.
  // Отказываем, а не пропускаем: незаполненная переменная окружения не должна
  // тихо выключать защиту — именно так и появляются дыры после переезда.
  if (typeof publicOrigin !== 'string' || !publicOrigin) {
    return { ok: false, error: 'not_configured' }
  }

  // Порядок проверок влияет только на то, какую ошибку увидит клиент:
  // барьеры независимы, и пройти нужно все три. Сначала самые дешёвые.
  const origin = checkOrigin(req, publicOrigin.toLowerCase())
  if (!origin.ok) return origin

  const type = checkContentType(req, contentTypes)
  if (!type.ok) return type

  return checkToken(req, session)
}
