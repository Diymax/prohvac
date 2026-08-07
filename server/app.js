// Единственный обработчик HTTP-запроса: разбирает путь и решает, кто отвечает.
//
// Здесь нет ни бизнес-логики, ни работы с базой сверх одной проверки — только
// порядок слоёв. Порядок и есть содержание файла, потому что каждый шаг
// опирается на инварианты предыдущего:
//
//   1. RequestContext — один canonical IP/request ID для всех следующих слоёв;
//   2. нормализация пути — дальше все слои считают путь безопасным;
//   3. security-заголовки — до того, как ответ начнёт собирать чужой код
//      (конвейер заявки про наши заголовки не знает);
//   4. готовность зависимой от базы части — вопрос, а не условие: статика
//      и оболочка SPA отдаются и при недоступной базе (CR-041);
//   5. блокировка IP — раньше всей полезной работы, иначе забаненный сканер
//      всё равно нагружает диск и базу;
//   6. маршруты API, потом публичные, потом файлы, и только в конце оболочка.
//
// Модуль не поднимает сервер: слушает порт server/index.js, а сюда приходит
// уже готовая пара (req, res). Так handleRequest можно вызывать из теста
// и из dev-сервера, не занимая порт.

import { join } from 'node:path'

import { attachResponseHelpers } from '../shared/http-compat.js'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { createRuntimeInitializer } from './application/runtime-initializer.js'
import { ensureRequestContext, isTrustedRequestHost } from './http/runtime-request-context.js'
import { apiNotFound, json, misdirected, securityHeaders, uniform404 } from './http/respond.js'
import { sendPublicShell, sendSpa } from './http/spa.js'
// enterAdminGate сам вызывает isAdminPath и shouldRevealAdmin в правильном
// порядке — отдельно они здесь не нужны, а собирать этот порядок вручную
// значило бы однажды его перепутать.
import { enterAdminGate, issueGateCookie, shouldRevealAdmin } from './auth/gate.js'
import { createThrottle, isHoneypot } from './auth/throttle.js'
import { createRateLimiter } from './lib/ratelimit.js'
import { registerAdmin2faRoutes } from './routes/admin.2fa.js'
import { registerAdminAuthRoutes } from './routes/admin.auth.js'
import { registerAdminContentRoutes } from './routes/admin.content.js'
import { registerAdminLeadsRoutes } from './routes/admin.leads.js'
import { registerAdminMediaRoutes } from './routes/admin.media.js'
import { registerAdminAnalyticsRoutes } from './routes/admin.analytics.js'
import { registerAdminOperationsRoutes } from './routes/admin.operations.js'
import { registerAdminSettingsRoutes } from './routes/admin.settings.js'
import { registerPublicContentRoutes } from './routes/public.content.js'
import { createTranslateWorker } from './translate/worker.js'
import { createProdLeadHandler } from './routes/public.lead.js'
import { registerTelegramWebhookRoute } from './routes/public.telegram.js'
import { WEBHOOK_PATH } from './application/telegram-crm.js'
import { IMMUTABLE, serveStatic } from './http/static.js'
import { createRouter } from './router.js'

// Предел длины строки запроса. Осмысленный путь на этом сайте — это десятки
// символов; всё, что длиннее, — заведомо перебор или попытка переполнить
// буфер разбора. Считаем до декодирования: именно столько байт пришло.
const MAX_URL_LENGTH = 512

// Percent-последовательность, ОСТАВШАЯСЯ после первого декодирования, значит
// двойное кодирование ('%252e%252e' -> '%2e%2e' -> '..'). Ниже по стеку путь
// декодирует ещё и static.js, и разница между «сколько раз декодировали здесь»
// и «сколько там» — классический способ протащить '..' мимо проверки.
// Отсекаем такие пути целиком: в dist и в медиа имена файлов состоят из
// латиницы, цифр, дефиса и точки, и знака '%' в них нет.
const DOUBLE_ENCODED = /%[0-9a-f]{2}/i

// Управляющие символы в пути не встречаются никогда, зато ломают логи
// и заголовки. NUL опаснее прочих: он обрезает строку в системных вызовах.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const MEDIA_PREFIX = '/media/'
const MEDIA_DIR = join(config.dataDir, 'media')

/**
 * Приводит req.url к безопасному пути или возвращает null, если запрос
 * разбирать не нужно вовсе.
 *
 * Возвращаемый путь: начинается со слэша, без query, без повторных и
 * завершающих слэшей, декодирован ровно один раз. На этот контракт опираются
 * и router.js, и все ветки dispatch().
 */
const normalizePath = (rawUrl) => {
  const url = typeof rawUrl === 'string' ? rawUrl : ''
  if (!url || url.length > MAX_URL_LENGTH) return null

  const pathname = url.split('?')[0].split('#')[0]
  // origin-form ('/path') — единственная форма, которую присылает браузер.
  // absolute-form ('http://host/path') приходит от прокси и открытых сканеров;
  // хост в ней наш собственный разбор доверять не должен.
  if (!pathname.startsWith('/')) return null

  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // Битый percent-encoding ('%zz') — мусор от клиента, а не сбой сервера.
    return null
  }

  if (CONTROL_CHARS.test(decoded) || DOUBLE_ENCODED.test(decoded)) return null
  // Обратный слэш на Windows — полноценный разделитель каталогов, и '..\\'
  // прошёл бы мимо разбора по '/'. Разработка идёт под Windows, хостинг Linux;
  // расхождение в этом месте означало бы дыру, которую локально не видно.
  if (decoded.includes('\\')) return null

  const segments = decoded.split('/').filter(Boolean)
  // '..' отсекаем здесь, чтобы ни один слой ниже не получил путь с выходом
  // вверх — даже тот, который сам его не проверяет. Одинокая '.' безвредна,
  // но означает ненормализованный путь, и пускать её дальше незачем.
  if (segments.some((segment) => segment === '.' || segment === '..')) return null

  return `/${segments.join('/')}`
}

const SQL_IP_BLOCKED = 'SELECT 1 AS blocked FROM ip_blocks WHERE ip_hash = ? AND blocked_until > ?'

/**
 * Действует ли блокировка. Запрос идёт в базу на каждом обращении, а не
 * в кэш процесса: процессов в пуле Passenger несколько, и разбан из админки
 * должен срабатывать сразу во всех, а не по мере истечения чужих кэшей.
 * Строка одна, поиск по первичному ключу — это микросекунды.
 *
 * При сбое базы отвечаем «не заблокирован». Обратное решение превратило бы
 * любую проблему с диском в полностью недоступный сайт, а цена ошибки здесь —
 * несколько запросов от того, кого и так уже поймали.
 */
const isIpBlocked = (ipHash) => {
  try {
    return Boolean(getDb().get(SQL_IP_BLOCKED, [ipHash, Date.now()]))
  } catch (error) {
    console.error(`[app] проверка ip_blocks не удалась: ${error.message}`)
    return false
  }
}

/**
 * Копия запроса с подменённым url.
 *
 * serveStatic берёт путь из req.url, а отдать ему нужно наш нормализованный
 * (и для медиа — обрезанный от префикса). Мутировать req.url нельзя: этот
 * объект видят и слои выше, и логирование, и обработчик ошибок, а тихая
 * подмена пути в них — источник расследований на полдня. Object.create
 * оставляет доступ к заголовкам, методу и сокету через прототип.
 */
const withPath = (req, path) => Object.create(req, { url: { value: path, enumerable: true } })

/**
 * Отдаёт файл или, если его нет, ту же оболочку, что и любой неизвестный URL.
 */
const serveFileOrShell = async (req, res, path, options) => {
  const served = await serveStatic(withPath(req, path), res, options)
  if (!served) await uniform404(req, res)
}

// ---------------------------------------------------------------------------
// Маршруты
// ---------------------------------------------------------------------------

let apiRouter = createRouter()
let publicRouter = createRouter()

/**
 * Тонкий адаптер к server/application/lead-pipeline.js. Тело здесь намеренно не читается: единый
 * lead pipeline сам выполняет method/origin/type/size/rate checks до parser,
 * поэтому второй читатель потока нарушил бы порядок и serverless parity.
 */
// Ленивая сборка: getDb() внутри открывает файл базы, и делать это на импорте
// модуля нельзя — тогда даже отдача статики требовала бы готовой БД.
let leadHandler = null
const getLeadHandler = () => (leadHandler ??= createProdLeadHandler())

const leadRoute = async (req, res) => {
  attachResponseHelpers(res)
  await getLeadHandler()(req, res)
}

apiRouter.register('ALL', '/api/lead', leadRoute)

// Маршруты собираются в НОВЫХ роутерах и публикуются одной заменой ссылок
// только после открытия БД, миграций и инициализации worker dependencies.
// Поэтому сбой в середине не оставляет половину маршрутов зарегистрированной,
// а повторная попытка не создаёт их дублей.
const initializeDbRoutes = () => {
  const db = getDb()
  runMigrations(db)

  const nextApiRouter = createRouter()
  const nextPublicRouter = createRouter()
  nextApiRouter.register('ALL', '/api/lead', leadRoute)

  // Маршруту входа нужен именно лимитер (hit/reset по ведру), а не модуль
  // эскалации из auth/throttle.js: тот работает уровнем выше — его блокировки
  // проверяет dispatch до всякой маршрутизации, и он же штрафует за honeypot.
  registerAdminAuthRoutes(nextApiRouter, { db, throttle: createRateLimiter(db) })
  registerAdmin2faRoutes(nextApiRouter, { db })

  // Воркер перевода один на процесс: он держит аренду в app_state, поэтому
  // при пуле Passenger пачку обработает ровно один из процессов.
  const translator = createTranslateWorker(db)
  registerAdminContentRoutes(nextApiRouter, {
    db,
    // Сохранение русского текста ставит задачи и тут же будит воркер.
    //
    // Сигнатура — ОДИН объект: именно так вызывает admin.content.js. Раньше
    // здесь стояли позиционные аргументы, и в SQL уходил объект вместо
    // строки; исключение глоталось, а редактор видел «поставлено в очередь 0»
    // и ждал перевод, которого не будет никогда.
    enqueueTranslation: ({ key, lang, sourceText, force = false } = {}) => {
      const result = translator.enqueueForKey(key, sourceText, {
        langs: lang ? [lang] : undefined,
        force,
      })
      if (result.queued.length) {
        setImmediate(() => {
          translator.tick().catch((error) => {
            console.error('[translate] проход очереди не удался:', error.message)
          })
        })
      }
      return result
    },
    translateStatus: () => translator.status(),
  })
  registerAdminMediaRoutes(nextApiRouter, { db })
  registerAdminSettingsRoutes(nextApiRouter, { db })
  registerAdminLeadsRoutes(nextApiRouter, { db })
  registerAdminOperationsRoutes(nextApiRouter, {
    db,
    translateStatus: () => translator.status(),
    runtimeStatus: () => dbRuntime.status(),
  })
  registerAdminAnalyticsRoutes(nextApiRouter, { db })
  // Вебхук Telegram — публичный адрес, но живёт на apiRouter: он под '/api/'.
  // Аутентификация у него своя (секрет в заголовке), поэтому сессия и CSRF,
  // общие для '/api/admin/*', его не касаются.
  registerTelegramWebhookRoute(nextApiRouter, { db })
  // Переводы и структурный контент отдаются из content_entries. Адрес прежний,
  // поэтому ни src/language/i18next.js, ни компоненты трогать не пришлось.
  // Если таблица пуста (сид не запускали), модуль сам отдаёт файл с диска —
  // сайт не должен превращаться в скелет из-за незаполненной базы.
  registerPublicContentRoutes(nextPublicRouter, { db, apiRouter: nextApiRouter })

  apiRouter = nextApiRouter
  publicRouter = nextPublicRouter
}

// CR-042. Число попыток больше не ограничено: процесс, однажды не открывший
// базу, обязан открыть её сам, когда диск вернётся, — без перезапуска пула.
// Ограничена ЧАСТОТА: между попытками растущая пауза со случайным разбросом,
// иначе четыре процесса Passenger колотили бы восстанавливающийся диск в такт.
const dbRuntime = createRuntimeInitializer({
  initialize: initializeDbRoutes,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  // Пол на любую паузу: всплеск запросов не должен превращаться во всплеск
  // попыток открыть базу.
  cooldownMs: 250,
  // Ошибка конфигурации (нет прав на каталог, файл не база) частым повтором
  // не лечится — до неё нужен оператор, поэтому пауза длинная.
  permanentDelayMs: 60_000,
  onFailure: ({ attempt, errorClass, errorCode, nextRetryAt, error }) => {
    // Раз на попытку, а не раз на запрос: во время сбоя запросов сотни.
    // В лог (не клиенту) сообщение можно: оно нужно, чтобы понять причину.
    console.error(
      `[app] инициализация БД не удалась (попытка ${attempt}, ${errorClass}` +
      `${errorCode ? `/${errorCode}` : ''}): ${error?.message ?? error}. ` +
      `Следующая попытка не раньше ${new Date(nextRetryAt).toISOString()}.`
    )
  },
})

/**
 * Готовит зависимые от базы маршруты. НЕ бросает.
 *
 * CR-041: отдача статики и оболочки SPA не должна зависеть от состояния базы,
 * поэтому конвейер спрашивает про готовность, а не ловит исключение где-то
 * посередине. Причина сбоя уже записана в лог обработчиком onFailure.
 */
const ensureRuntimeReady = async () => {
  try {
    await dbRuntime.ensure()
    return true
  } catch {
    return dbRuntime.isReady()
  }
}

export const runtimeInitializationStatus = () => dbRuntime.status()

/**
 * Запрещает новые попытки инициализации. Вызывается при остановке процесса:
 * регистрировать маршруты и открывать базу, когда её вот-вот закроют, незачем.
 */
export const stopRuntimeInitialization = () => dbRuntime.shutdown()

// ---------------------------------------------------------------------------
// Конвейер
// ---------------------------------------------------------------------------

const isApiPath = (path) => path === '/api' || path.startsWith('/api/')

const acceptsHtml = (req) => {
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

const isAdminApiPath = (path) => path.startsWith('/api/admin/') || path === '/api/admin'

// Минимум для Retry-After: ноль означал бы «повторяй немедленно», а именно
// этого при недоступной базе делать не надо.
const RETRY_AFTER_FLOOR_S = 1

/**
 * Ответ API, пока база недоступна (CR-041).
 *
 * 503 с Retry-After и request ID, без единой подробности о причине: класс
 * ошибки ('configuration' / 'infrastructure') говорит оператору, куда смотреть,
 * а сообщение и стек остаются в логе — они содержат пути на диске и куски SQL.
 *
 * Отдельный код ответа здесь принципиален для входа в админку: 401
 * invalid_credentials на сбое базы означал бы, что администратор ищет
 * забытый пароль вместо упавшего диска.
 */
const serviceUnavailable = (res, requestId) => {
  const status = dbRuntime.status()
  const retryAfterSeconds = Math.max(
    RETRY_AFTER_FLOOR_S,
    Math.ceil((status.retryAfterMs ?? 0) / 1000)
  )

  res.setHeader('Retry-After', String(retryAfterSeconds))
  json(res, 503, {
    ok: false,
    error: 'service_unavailable',
    reason: status.errorClass,
    permanent: status.permanent,
    retryAfterSeconds,
    requestId,
  })
}

const handleApi = async (req, res, path, { runtimeReady, requestId }) => {
  // Админский API прячется тем же гейтом, что и страницы панели: без него
  // /api/admin/* отвечал бы иначе, чем несуществующий /api/*, и по одной этой
  // разнице панель находится без единой попытки входа.
  if (isAdminApiPath(path)) {
    if (!shouldRevealAdmin(req, config)) {
      apiNotFound(res)
      return
    }
    // Гейт-кука живёт 30 минут и выдавалась только при заходе по секретному
    // пути. Сессия при этом продлевалась каждым запросом, поэтому через
    // полчаса работы панель начинала получать 404 на каждое действие,
    // а вернуть её мог только повторный заход по секретному адресу.
    // Продлеваем окно, пока человек работает.
    if (config.adminRequireGate) issueGateCookie(res)
  }

  // Проверка готовности идёт ПОСЛЕ маскировки админского API: 503 на закрытом
  // /api/admin/* сообщал бы о существовании панели ровно так же, как это
  // сделал бы любой другой ответ, отличающийся от фонового 404.
  if (!runtimeReady) {
    serviceUnavailable(res, requestId)
    return
  }

  const matched = apiRouter.match(req.method, path)
  // Промах внутри /api/* — это JSON, а не оболочка: клиент здесь ждёт JSON
  // и HTML всё равно не разберёт. Админские пути сюда не попадут, они уйдут
  // в uniform404 (см. комментарий к нему в http/respond.js).
  if (!matched) {
    apiNotFound(res)
    return
  }
  if (!matched.handler) {
    res.setHeader('Allow', matched.allow.join(', '))
    json(res, 405, { ok: false, error: 'method_not_allowed' })
    return
  }
  await matched.handler(req, res, matched.params)
}

const dispatch = async (req, res) => {
  const requestContext = ensureRequestContext(req)
  res.setHeader('X-Request-ID', requestContext.requestId)

  // CR-049. Host проверяем до разбора пути и до любой работы с базой: запрос,
  // адресованный чужому имени, не должен доходить ни до маршрутов, ни до
  // оболочки SPA — именно её DNS rebinding и хочет исполнить в origin
  // подставленного имени. uniform404 здесь не подходит: он как раз отдаёт
  // оболочку, то есть выполнил бы работу атакующего.
  if (!isTrustedRequestHost(req)) {
    misdirected(res)
    return
  }

  const path = normalizePath(req.url)
  // Путь не разобрался — отвечаем как на любой неизвестный адрес.
  // Отдельный код ответа здесь подсказывал бы сканеру, что его конструкция
  // до сервера доехала и была распознана. Заголовки поставит sendSpa.
  if (path === null) {
    await uniform404(req, res)
    return
  }

  securityHeaders(res)
  // CR-041. Готовность базы — не условие ответа, а факт, который знают
  // следующие шаги: статика, оболочка SPA и маскировка админки обязаны
  // работать и при недоступной базе, иначе сбой диска гасит сайт целиком.
  const runtimeReady = await ensureRuntimeReady()

  const ipHash = requestContext.ipHash

  // Заблокированный получает ту же оболочку, что и все: 403 или пустой ответ
  // сообщили бы, что защита сработала, и подсказали бы, чем именно её
  // зацепило. Пусть выглядит как обычный сайт, на котором ничего не находится.
  // Вебхук Telegram выведен из-под блокировки по IP намеренно.
  //
  // Блокировка считается по ipHash, а он при незаданном TRUSTED_PROXY_CIDRS
  // (умолчание) за обратным прокси одинаков у ВСЕХ запросов: адрес сокета —
  // это адрес прокси. Один сканер, дёрнувший honeypot, штрафует общий хеш
  // на сутки, и с этого момента Telegram получает uniform404 — кнопки статуса
  // в чате перестают работать без единой строчки в логе, а причина находится
  // только через getWebhookInfo().
  //
  // Подменять этим защиту нечем: подлинность вебхука даёт секрет в заголовке,
  // а не адрес отправителя, и у маршрута есть собственный лимит частоты.
  if (runtimeReady && path !== WEBHOOK_PATH && isIpBlocked(ipHash)) {
    await uniform404(req, res)
    return
  }

  // По этим адресам ходят только сканеры: живой посетитель на /.env не попадёт
  // никогда. Считаем обращение уликой и сразу штрафуем, но отвечаем как обычно —
  // пусть перебор выглядит успешным и тратит чужое время впустую.
  if (isHoneypot(path)) {
    // Штраф пишется в базу. Пока она недоступна, записывать некуда — ответ при
    // этом обязан остаться прежним, иначе недоступность базы сама становится
    // сигналом сканеру, что он нащупал honeypot.
    if (runtimeReady) {
      try {
        // registerHoneypot, а не registerFailure: у второго стадия проверяется
        // по списку ('password','totp','recovery'), и переданная сюда 'gate'
        // бросала TypeError. Исключение глоталось пустым catch, поэтому
        // защита не срабатывала НИ РАЗУ и молчала об этом — сканер спокойно
        // перебирал пути дальше.
        createThrottle(getDb()).registerHoneypot({ ipHash })
      } catch (error) {
        // Штраф — не причина ломать ответ, но и молчать нельзя: именно
        // молчание скрывало предыдущую поломку.
        console.error(`[app] honeypot не отработал: ${error.message}`)
      }
    }
    await uniform404(req, res)
    return
  }

  // Админские адреса. enterAdminGate на секретном пути выдаёт гейт-куку
  // (сама она прав не даёт — только снимает маскировку) и сразу же решает,
  // показывать панель или нет: порядок «сначала выдать, потом проверить»
  // важен, иначе первый заход по секретному пути закрывал бы админку навсегда.
  const gate = enterAdminGate(req, res, path, config)
  if (gate.isAdmin) {
    // Без пройденного гейта админский адрес обязан быть неотличим
    // от несуществующего — тот же uniform404, что и на любой мусорный путь.
    if (!gate.reveal) {
      await uniform404(req, res)
      return
    }
    // Оболочка ровно та же, что и на остальных путях: различие в теле ответа
    // само по себе выдало бы наличие панели. Что рисовать, решает клиент,
    // опросив /api/admin/session — этот запрос без гейт-куки тоже даёт 404.
    //
    // sendSpa, а НЕ sendPublicShell: счётчик на этой странице отправил бы
    // в Метрику секретный путь админки, а Вебвизор записал бы саму панель —
    // заявки с именами и телефонами, привязку TOTP, поля настроек.
    await sendSpa(req, res)
    return
  }

  if (isApiPath(path)) {
    await handleApi(req, res, path, { runtimeReady, requestId: requestContext.requestId })
    return
  }

  const matched = publicRouter.match(req.method, path)
  // matched без handler — известный путь, но другой метод. Для публичных
  // адресов это не повод отвечать 405: пусть выглядит как остальной фон,
  // поэтому просто идём дальше по конвейеру.
  if (matched?.handler) {
    await matched.handler(req, res, matched.params)
    return
  }

  // Медиа лежит в DATA_DIR, а не в dist: файлы переживают выкат новой сборки
  // и не попадают в git. Имя content-addressed (server/lib/image.js), то есть
  // по одному URL всегда один и тот же байт, — отсюда immutable.
  if (path.startsWith(MEDIA_PREFIX)) {
    const mediaPath = path.slice(MEDIA_PREFIX.length - 1)
    await serveFileOrShell(req, res, mediaPath, { root: MEDIA_DIR, cacheControl: IMMUTABLE })
    return
  }

  // '/index.html' — не файл, а второй адрес главной страницы. Через статику
  // он ушёл бы клиенту как есть: без заголовка CSP и без подстановки nonce,
  // то есть браузер заблокировал бы собственные скрипты страницы. serveStatic
  // перехватывает только '/', поэтому второй адрес закрываем здесь.
  if (path === '/index.html') {
    await sendPublicShell(req, res)
    return
  }

  if (await serveStatic(withPath(req, path), res)) return

  // У публичного приложения пока один разрешённый route — корень. Секретный
  // admin route уже обработан выше. Любой другой HTML URL получает настоящую
  // 404-оболочку, которую клиент превращает в Not Found screen.
  if (path === '/' && (req.method === 'GET' || req.method === 'HEAD') && acceptsHtml(req)) {
    await sendPublicShell(req, res)
    return
  }

  await uniform404(req, res)
}

/**
 * Ответ на сбой в самом конвейере. Подробностей клиенту не даём: причина уже
 * в логе, а текст ошибки Node охотно печатает пути на диске и куски SQL.
 */
const sendServerError = (res) => {
  if (res.writableEnded) return
  if (res.headersSent) {
    // Часть ответа уже ушла, дописать статус нечем. Рвём соединение, чтобы
    // клиент увидел обрыв, а не принял обрезанное тело за целое.
    res.destroy()
    return
  }
  json(res, 500, { ok: false, error: 'internal_error' })
}

/**
 * Точка входа сервера.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Function} [next] обработчик ошибки в стиле connect. Нужен, когда
 *   handleRequest подключают middleware'ом (dev-сервер, тесты): такой слой
 *   умеет показать стек в браузере лучше, чем мы. Под Passenger его нет,
 *   и ответ 500 собираем сами.
 */
export const handleRequest = async (req, res, next) => {
  try {
    await dispatch(req, res)
  } catch (error) {
    console.error(`[app] ${req.method} ${req.url}`, error)
    if (typeof next === 'function') {
      next(error)
      return
    }
    sendServerError(res)
  }
}
