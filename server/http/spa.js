// Отдача оболочки SPA (dist/index.html).
//
// Оболочка одна на весь сайт: и корень, и любой маршрут React Router, и ответ
// uniform404 — это один и тот же HTML. Отличается в нём ровно одно — nonce
// для Content-Security-Policy, свой на каждый ответ.
//
// ВАЖНО про сборку: политика ниже НЕ содержит 'unsafe-inline' в script-src,
// поэтому каждый инлайновый <script> в index.html (сниппет GTM, ld+json)
// обязан нести атрибут nonce="__CSP_NONCE__" — плейсхолдер подставляется
// здесь. Скрипт без него браузер просто не выполнит.

import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { config } from '../config.js'
import { stripAnalyticsMarkup } from '../../shared/analytics-markup.js'
import { securityHeaders } from './respond.js'
import { DIST_DIR } from './static.js'

const NONCE_PLACEHOLDER = '__CSP_NONCE__'

// CR-064. Блоки аналитики вырезаются из оболочки везде, где счётчик не положен.
//
// Изначально причина была одна: inline-загрузчик несёт nonce (CR-061) и потому
// исполняется, а домен аналитики в script-src не попадает (CR-051) — браузер
// отвергает внешний скрипт, пользователь получает мусор в консоли, аналитика
// всё равно не работает.
//
// Вторая причина появилась вместе с Яндекс.Метрикой и она серьёзнее. Оболочка
// в этом проекте ОДНА на всё: публичная главная, страница админки на секретном
// пути и любой uniform404 — это один и тот же index.html (см. server/app.js).
// Счётчик, оставленный в оболочке админки, отправил бы в Метрику
// ADMIN_SECRET_PATH (он попадёт в отчёт «Страницы входа» и станет виден всем,
// у кого есть гостевой доступ к счётчику), а Вебвизор записал бы саму панель:
// список заявок с именами и телефонами, экран привязки TOTP, поля настроек.
// Вся защита админки держится на секретности пути, поэтому счётчик отдаётся
// ТОЛЬКО через sendPublicShell() — см. комментарий к нему ниже.
//
// Границы — те же HTML-комментарии, что стоят в index.html. Совпадение
// проверяется тестом: если разметку переименуют, тест упадёт, а не молча
// перестанет вырезать.
//
// Сами выражения переехали в shared/analytics-markup.js: их понадобилось
// звать ещё и из vite.config.js, а импортировать туда этот модуль нельзя —
// он тянет server/config.js со чтением окружения.
export { stripAnalyticsMarkup } from '../../shared/analytics-markup.js'

// 16 байт — 128 бит энтропии, предсказать nonce нельзя. base64 от 16 байт
// всегда ровно 24 символа, и это не мелочь: постоянная длина держит
// Content-Length одинаковым у всех ответов оболочки, а на этом стоит
// неотличимость uniform404 (см. комментарий в respond.js).
const NONCE_BYTES = 16

const FONTS_CSS = 'https://fonts.googleapis.com'
const FONTS_FILES = 'https://fonts.gstatic.com'

// Домены Яндекс.Метрики перечислены здесь и подключаются к политике ТОЛЬКО
// при ANALYTICS_ENABLED=1. Раньше домены аналитики стояли в CSP безусловно,
// то есть на сайте без аналитики оставался разрешённый канал к стороннему
// скрипту и произвольный получатель для connect-src — ровно то, чем
// пользуется внедрённый код, чтобы вынести данные.
//
// Список намеренно минимальный: только то, что счётчик реально запрашивает
// с этого сайта. Региональные зеркала (mc.yandex.com, mc.yandex.uz,
// mc.webvisor.org) НЕ добавлены заранее — если в консоли появится отказ
// на конкретный домен, добавлять надо его, а не весь список из документации.
// Иначе повторится история GTM: три разрешённых домена ради кода, который
// ничего не делает.
//
// Что зачем:
//   script  — сам tag.js плюс yastatic.net, CDN дополнительных модулей;
//             без второго часть функций молча не грузится;
//   img     — пиксельные хиты и <img> из noscript-блока;
//   connect — отправка хитов; wss нужен транспорту Вебвизора 2.0, без него
//             в консоли «Refused to connect to wss://…», записи пустые;
//   frame/child — Вебвизор и карты кликов рисуются в blob-iframe; без blob:
//             Вебвизор молчит вообще без внятной ошибки.
//
// Метрике НЕ нужны ни 'unsafe-inline', ни 'unsafe-eval': политика не слабеет.
// frame-ancestors 'none' тоже остаётся — директива из документации Метрики
// нужна, только если СВОЮ страницу встраивают в интерфейс Метрики.
//
// ПРО ВЕБВИЗОР ОТДЕЛЬНО. Записи сеансов Вебвизор 2.0 отправляет НЕ на
// mc.yandex.ru, а на mc.webvisor.org — это отдельный домен, и в списке выше
// его не было. Последствие ровно то, от которого предостерегает абзац про
// «молча не грузится»: webvisor:true включён, скрипт собирает записи, каждая
// отправка отвергается политикой, а в интерфейсе Метрики счётчик выглядит
// живым (просмотры-то уходят на mc.yandex.ru) при пустом отчёте Вебвизора.
// Домен добавлен и в connect (https и wss — транспорта два), и в img.
const ANALYTICS_SOURCES = Object.freeze({
  script: ['https://mc.yandex.ru', 'https://yastatic.net'],
  // yandex.ru — пиксель синхронизации аудиторий (/an/mapuid/...), который
  // счётчик запрашивает сам. Домен добавлен по факту отказа в консоли, как
  // и предписано абзацем выше, а не «на всякий случай» из документации.
  // Без него работают и просмотры, и цели, и Вебвизор — не работает только
  // сопоставление аудиторий с Яндекс.Директом. Это img-src: картинка ничего
  // не исполняет, поэтому разрешение узкое по последствиям.
  img: ['https://mc.yandex.ru', 'https://mc.webvisor.org', 'https://yandex.ru'],
  connect: [
    'https://mc.yandex.ru',
    'wss://mc.yandex.ru',
    'https://mc.webvisor.org',
    'wss://mc.webvisor.org',
  ],
  frame: ['blob:', 'https://mc.yandex.ru'],
  child: ['blob:', 'https://mc.yandex.ru'],
})

const directive = (name, ...sources) => `${name} ${sources.flat().filter(Boolean).join(' ')}`

/**
 * Собирает политику для одного ответа.
 *
 * options существуют ради тестов заголовков: боевые значения берутся
 * из config, а тест должен уметь проверить каждую конфигурацию отдельно,
 * не перезапуская процесс с другим окружением.
 */
export const buildCsp = (
  nonce,
  { analytics = config.analyticsEnabled, production = config.isProduction } = {}
) => {
  const analyticsSource = (kind) => (analytics ? ANALYTICS_SOURCES[kind] : [])

  const directives = [
    "default-src 'self'",

    // style-src-elem без 'unsafe-inline': <style> и <link rel=stylesheet>
    // на странице только свои (Vite выносит CSS в отдельный файл, инлайновых
    // <style> сборка не создаёт), поэтому разрешать вставку целого блока
    // стилей незачем — а именно так работает CSS-эксфильтрация и подмена
    // вёрстки поверх формы заявки.
    directive('style-src-elem', "'self'", FONTS_CSS),

    // style-src-attr с 'unsafe-inline' — осознанное исключение, не удобство.
    // Инвентаризация инлайновых стилей на 2026-07-30: все шесть мест — это
    // атрибут style у React-элемента с ВЫЧИСЛЯЕМЫМ значением
    // (src/components/Hero.jsx:14 и Stats.jsx:17 — url картинки из бандла,
    // src/admin/components/QuotaBar.jsx:39 — ширина в процентах,
    // src/components/About.jsx:9, Header.jsx:204,233 — фиксированные),
    // плюс style у noscript-картинки Метрики в index.html (её увести
    // за экран больше нечем: своего класса у неё нет, а сниппет положено
    // держать в том виде, в каком его отдаёт Метрика). Атрибут нельзя занонсить
    // в принципе, а хеш работает только для неизменного текста, которого
    // у динамических значений нет. Оставляем как есть: исполняемого кода
    // в CSS нет, а переписывание вёрстки лежит вне границ этой задачи.
    "style-src-attr 'unsafe-inline'",

    // style-src — запасной вариант для браузеров без поддержки -elem/-attr.
    // Они прочитают только его; браузеры с поддержкой -elem/-attr его
    // игнорируют и получают политику строже.
    directive('style-src', "'self'", "'unsafe-inline'", FONTS_CSS),

    directive('font-src', "'self'", FONTS_FILES),
    directive('img-src', "'self'", 'data:', analyticsSource('img')),
    directive('connect-src', "'self'", analyticsSource('connect')),

    directive('script-src', "'self'", `'nonce-${nonce}'`, analyticsSource('script')),

    // base-uri: без неё внедрённый <base href> переписывает все относительные
    // ссылки страницы на чужой домен, не нарушая при этом script-src.
    "base-uri 'self'",
    // form-action: не даёт увести отправку формы заявки на сторонний хост.
    "form-action 'self'",
    "object-src 'none'",
    // frame-ancestors дублирует X-Frame-Options для браузеров, которые
    // устаревший заголовок уже не читают.
    "frame-ancestors 'none'",
  ]

  // frame-src/child-src только при включённой аналитике: без них фреймы
  // подчиняются default-src 'self', то есть чужой iframe не встроить вовсе.
  // child-src — запасной вариант для браузеров, которые frame-src не читают.
  if (analytics) {
    directives.push(directive('frame-src', ANALYTICS_SOURCES.frame))
    directives.push(directive('child-src', ANALYTICS_SOURCES.child))
  }

  // Только в проде: локально сайт работает по http, и апгрейд превратил бы
  // каждый запрос к dev-серверу в неудачный https.
  if (production) directives.push('upgrade-insecure-requests')

  return directives.join('; ')
}

/** nonce должен быть непредсказуемым, поэтому CSPRNG, а не Math.random. */
const createNonce = () => randomBytes(NONCE_BYTES).toString('base64')

let cachedShell = null
let cachedShellWithoutAnalytics = null

/**
 * index.html между релизами не меняется, а перезапуск Passenger сбрасывает
 * кэш — держим содержимое в памяти процесса. Это копия неизменяемого
 * артефакта сборки, а не разделяемое состояние, поэтому дублирование
 * по процессам пула безвредно.
 *
 * Кэшируются оба варианта: вариант без счётчика уходит на КАЖДЫЙ 404 и на
 * каждую страницу админки, то есть на большинство ответов, и гонять по нему
 * две регулярки каждый раз незачем.
 *
 * Вне прода читаем каждый раз: иначе правка dist/index.html не видна
 * до перезапуска сервера.
 */
const loadShell = async (indexPath, { analytics }) => {
  const cached = analytics ? cachedShell : cachedShellWithoutAnalytics
  if (config.isProduction && cached) return cached

  const raw = await fsp.readFile(indexPath, 'utf8')
  const html = analytics ? raw : stripAnalyticsMarkup(raw)
  if (config.isProduction) {
    if (analytics) cachedShell = html
    else cachedShellWithoutAnalytics = html
  }
  return html
}

/**
 * Аварийный ответ, когда dist/index.html недоступен. Сайта в этот момент
 * нет вообще, поэтому текст минимальный и без подробностей: причина уходит
 * в лог, клиенту знать имя и путь файла незачем.
 */
const sendShellFailure = (res) => {
  if (res.headersSent || res.writableEnded) return
  const body = Buffer.from('Service Unavailable', 'utf8')
  securityHeaders(res)
  res.statusCode = 503
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(res.req?.method === 'HEAD' ? undefined : body)
}

/**
 * Отдаёт SPA-оболочку с подставленным CSP-nonce. БЕЗ счётчика аналитики.
 *
 * Отсутствие счётчика здесь — не забывчивость, а сама защита. Через эту
 * функцию проходят и админская оболочка, и каждый uniform404, и любой новый
 * маршрут, который кто-то добавит через год. Счётчик отдаётся отдельным
 * входом sendPublicShell(), поэтому «забыть выключить аналитику» невозможно —
 * можно только забыть её включить, а это видно сразу и стоит дёшево.
 *
 * options.indexPath — путь к index.html, по умолчанию dist/index.html.
 * options.analytics — внутренний флаг, ставится только sendPublicShell().
 */
export const sendSpa = async (req, res, status = 200, options = {}) => {
  if (res.headersSent || res.writableEnded) return

  const indexPath = options.indexPath || join(DIST_DIR, 'index.html')
  // Аналитика требует ОБОИХ условий: включённого деплоем флага и явного
  // разрешения от вызывающего маршрута.
  const analytics = config.analyticsEnabled && options.analytics === true

  let html
  try {
    // Вырезание живёт внутри loadShell, до подстановки nonce: незачем
    // выдавать nonce скрипту, который всё равно не поедет.
    html = await loadShell(indexPath, { analytics })
  } catch (error) {
    console.error(`[spa] не удалось прочитать ${indexPath}: ${error.message}`)
    sendShellFailure(res)
    return
  }

  const nonce = createNonce()
  let rendered = html.replaceAll(NONCE_PLACEHOLDER, nonce)
  if (status === 404) {
    rendered = rendered.replace(
      '</head>',
      '    <meta name="robots" content="noindex, nofollow" />\n  </head>'
    )
  }
  const body = Buffer.from(rendered, 'utf8')

  securityHeaders(res)
  res.statusCode = status
  // Политика собирается под ФАКТИЧЕСКИ отданную разметку, а не под флаг
  // деплоя: на странице админки счётчика нет, и разрешать ей связь с
  // mc.yandex.ru незачем — это был бы открытый канал наружу ровно там, где
  // на экране лежат заявки и настройки. Content-Length от этого не зависит
  // (CSP — заголовок), поэтому неотличимость uniform404 не страдает.
  res.setHeader('Content-Security-Policy', buildCsp(nonce, { analytics }))
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  // no-store, а не max-age: nonce одноразовый. Закэшированная оболочка
  // приедет со старым nonce, и браузер заблокирует собственные скрипты
  // страницы — сайт откроется пустым.
  res.setHeader('Cache-Control', 'no-store')
  if (status === 404) res.setHeader('X-Robots-Tag', 'noindex, nofollow')

  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * Публичная страница сайта — единственный ответ, который получает счётчик.
 *
 * Отдельная функция, а не флаг в options у sendSpa: маршрутов, отдающих
 * оболочку, четыре (главная, /index.html, админка на секретном пути,
 * uniform404), и три из них счётчик получать не должны. Флаг в общем входе
 * означал бы, что безопасное поведение надо каждый раз помнить; отдельный
 * вход означает, что его надо каждый раз просить.
 *
 * Вызывать ТОЛЬКО из веток, отдающих публичный лендинг. Список вызовов
 * сторожит тест: sendPublicShell не должен появиться ни в админской ветке,
 * ни в uniform404.
 */
export const sendPublicShell = (req, res, options = {}) =>
  sendSpa(req, res, 200, { ...options, analytics: true })
