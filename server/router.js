// Сопоставление маршрутов. Без зависимостей: весь роутинг сервера — это
// десяток фиксированных путей вида '/api/admin/session' и один
// параметрический '/locales/:lng/translation.json'. Ради этого тянуть внешний
// пакет незачем, а любой пакет здесь — ещё и код, который парсит путь
// по своим правилам, отличным от нормализации в server/app.js.
//
// Матчер работает по СЕГМЕНТАМ уже нормализованного пути: сюда приходит
// строка, которая начинается со слэша, не содержит query, повторных слэшей,
// '..' и percent-последовательностей (см. normalizePath в server/app.js).
// Поэтому здесь нет ни декодирования, ни проверок безопасности — вторая
// реализация тех же правил неизбежно разошлась бы с первой.

// Метод-джокер для обработчиков, которые сами решают, что делать с методом
// (например, конвейер заявки: он отвечает и на OPTIONS, и на 405 с Allow).
const ANY_METHOD = 'ALL'

/**
 * Разбирает шаблон в список сегментов. Сегмент вида ':name' — параметр,
 * остальные сравниваются буквально.
 */
const parsePattern = (pattern) => {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
    throw new TypeError(`router: шаблон должен начинаться со слэша, получено "${pattern}"`)
  }

  return pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment[0] !== ':') return { name: segment, param: false }
      const name = segment.slice(1)
      // Пустое имя ':' дало бы параметр с ключом '' — тихо теряющийся
      // в params и невидимый при чтении шаблона.
      if (!name) throw new TypeError(`router: в шаблоне "${pattern}" параметр без имени`)
      return { name, param: true }
    })
}

/**
 * Сверяет разобранный шаблон с сегментами пути.
 * Возвращает объект параметров или null, если путь не подходит.
 */
const matchSegments = (parts, segments) => {
  if (parts.length !== segments.length) return null

  const params = {}
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (part.param) params[part.name] = segments[i]
    else if (part.name !== segments[i]) return null
  }
  return params
}

/**
 * Создаёт независимый набор маршрутов. Их несколько (API и публичные пути),
 * потому что порядок обработки в app.js между ними разный: промах по /api/*
 * обязан отдать JSON, а промах по публичному пути — SPA-оболочку.
 */
export const createRouter = () => {
  const routes = []

  /**
   * @param {string} method метод в любом регистре либо 'ALL'
   * @param {string} pattern путь-шаблон, например '/locales/:lng/translation.json'
   * @param {Function} handler (req, res, params) => Promise|void
   */
  const register = (method, pattern, handler) => {
    if (typeof handler !== 'function') {
      throw new TypeError(`router: обработчик для ${method} ${pattern} не функция`)
    }

    const verb = String(method).toUpperCase()
    // CR-042. Повторная регистрация того же пути — не «последний побеждает»,
    // а тихая потеря обработчика: match() возвращает ПЕРВЫЙ подошедший, то есть
    // работал бы старый, а автор правки видел бы в коде новый. Такое состояние
    // и создавала бы повторная инициализация рантайма, поэтому оно обязано
    // падать сразу и громко, а не на первом запросе через полгода.
    const clash = routes.find(
      (route) =>
        route.pattern === pattern &&
        (route.method === verb || route.method === ANY_METHOD || verb === ANY_METHOD)
    )
    if (clash) {
      throw new TypeError(
        `router: ${verb} ${pattern} уже зарегистрирован (${clash.method} ${clash.pattern})`
      )
    }

    routes.push({
      method: verb,
      pattern,
      parts: parsePattern(pattern),
      handler,
    })
  }

  /**
   * Ищет обработчик.
   *
   * Возвращает:
   *   { handler, params }        — маршрут найден;
   *   { handler: null, allow }   — путь известен, но не для этого метода;
   *   null                       — такого пути нет.
   *
   * Разделение важно: 405 подтверждает существование пути, поэтому решение
   * «отдавать 405 или прятать путь» принимает вызывающий, а не матчер.
   */
  const match = (method, path) => {
    const verb = String(method).toUpperCase()
    // HEAD обслуживает обработчик GET: тело отрезает слой ответа
    // (см. isHead в server/http/respond.js), а отдельный маршрут под HEAD —
    // это способ однажды забыть его обновить вместе с GET.
    const lookup = verb === 'HEAD' ? 'GET' : verb

    const segments = path.split('/').filter(Boolean)
    const allow = new Set()

    for (const route of routes) {
      const params = matchSegments(route.parts, segments)
      if (!params) continue
      if (route.method === ANY_METHOD || route.method === lookup) return { handler: route.handler, params }
      allow.add(route.method)
    }

    if (!allow.size) return null
    // GET без HEAD в Allow — формально неверно: HEAD мы обслуживаем всегда,
    // раз обслуживаем GET.
    if (allow.has('GET')) allow.add('HEAD')
    return { handler: null, params: null, allow: [...allow] }
  }

  return { register, match }
}
