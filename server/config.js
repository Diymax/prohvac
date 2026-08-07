// Единственное место в сервере, где читается process.env.
// Всё остальное импортирует уже проверенный и замороженный объект: иначе
// опечатка в имени переменной превращается в undefined где-то в глубине
// рантайма (пустой секрет, нулевая квота), а не в понятную ошибку.
//
// Валидация намеренно строгая и падает сразу. Под Passenger процесс с битым
// конфигом всё равно поднимется и будет отдавать 500 на каждый запрос —
// лучше не подняться совсем и оставить в логе одну внятную строку.
//
// Разделение ответственности:
//   импорт модуля  — валидирует то, что валидно проверить всегда (форматы,
//                    диапазоны, взаимная согласованность);
//   assertProductionConfig() — падает на отсутствующих/подставных секретах.
// Так конфиг можно импортировать в тестах и утилитах без боевых переменных,
// но боевой процесс без секретов не стартует. Вызывать в app.cjs до listen.

import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildAllowedOrigins, normalizeOrigin } from '../shared/origin.js'
import { compileAllowedHosts, compileTrustedProxyCidrs } from './http/request-context.js'

const MB = 1024 * 1024
const SECRET_MIN = 32
const ADMIN_PATH_MIN = 24

// Путь админки состоит из строчных латинских букв, цифр и дефиса: он попадает
// в URL, логи прокси и Referer, поэтому регистр и спецсимволы только создают
// расхождения между «тем же» путём в разных местах.
const ADMIN_PATH_PATTERN = /^[a-z0-9-]+$/

// Заглушки для локальной разработки. Префикс узнаваем намеренно:
// assertProductionConfig() отказывается стартовать, если такое значение
// скопировали в панель хостинга.
const DEV_PREFIX = 'dev-insecure-'
const DEV_APP_SECRET = `${DEV_PREFIX}app-secret-not-for-production`
const DEV_GATE_SECRET = `${DEV_PREFIX}gate-secret-not-for-production`
const DEV_ADMIN_PATH = `${DEV_PREFIX}admin-console`

const DEFAULT_TELEGRAM_API = 'https://api.telegram.org'

const fail = (message) => {
  throw new Error(`[config] ${message}`)
}

const warnings = []
const warn = (message) => warnings.push(message)

const raw = (name) => {
  const value = process.env[name]
  return value == null ? '' : String(value).trim()
}

const readInt = (name, fallback, min, max) => {
  const value = raw(name)
  if (!value) return fallback
  // Number, а не parseInt: parseInt('30abc') вернул бы 30 и молча проглотил
  // мусор, из-за которого значение вообще-то задано неверно.
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`${name} должен быть целым числом от ${min} до ${max}, получено "${value}"`)
  }
  return parsed
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

const readBool = (name, fallback) => {
  const value = raw(name).toLowerCase()
  if (!value) return fallback
  if (TRUE_VALUES.has(value)) return true
  if (FALSE_VALUES.has(value)) return false
  // Именно падение, а не Boolean(value): любая непустая строка в JS истинна,
  // поэтому опечатка ADMIN_LEGACY_PATH_ENABLED=fasle включила бы то,
  // что просили выключить, и никто бы этого не заметил.
  return fail(`${name} принимает только 0 или 1, получено "${value}"`)
}

/**
 * Разбирает источник (origin). Возвращает нормализованный вид без пути
 * и завершающего слэша, чтобы сравнение с заголовком Origin было точным:
 * браузер присылает ровно 'https://example.com'.
 */
const parseOrigin = (name, value, { allowHttp }) => {
  try {
    return normalizeOrigin(value, { allowHttp, label: name })
  } catch (error) {
    return fail(`${name}: ${error.message}`)
  }
}

const nodeEnv = raw('NODE_ENV') || 'development'
const isProduction = nodeEnv === 'production'

// Список того, чего не хватает для боевого запуска. Заполняется здесь,
// а бросается в assertProductionConfig() — см. комментарий в шапке.
const missing = []

const readSecret = (name, devValue) => {
  const value = raw(name)
  if (!value) {
    if (isProduction) {
      missing.push(name)
      return ''
    }
    warn(`${name} не задан — подставлено дев-значение. В прод такое не пойдёт.`)
    return devValue
  }
  if (value.length < SECRET_MIN) {
    fail(`${name} короче ${SECRET_MIN} символов (сейчас ${value.length}). ` +
      'Сгенерируйте: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"')
  }
  return value
}

const readPublicOrigin = () => {
  const value = raw('PUBLIC_ORIGIN')
  if (!value) {
    if (isProduction) {
      missing.push('PUBLIC_ORIGIN')
      return ''
    }
    warn('PUBLIC_ORIGIN не задан — используется http://localhost:5173.')
    return 'http://localhost:5173'
  }
  // http разрешён только вне прода: по PUBLIC_ORIGIN строятся абсолютные
  // ссылки и проверяется Origin, а cookie сессии идут с Secure.
  return parseOrigin('PUBLIC_ORIGIN', value, { allowHttp: !isProduction })
}

/**
 * Путь к админке — секрет, который целиком виден в URL и не защищён ничем,
 * кроме собственной длины: он утекает в логи прокси, в историю браузера
 * и в Referer. Короткий путь вроде /admin-2024 сканер перебирает по словарю
 * за часы. 24 символа из алфавита в 37 знаков — это ~125 бит, перебирать
 * такое бессмысленно, поэтому минимум зашит в код и не настраивается.
 */
const readAdminSecretPath = () => {
  const value = raw('ADMIN_SECRET_PATH')
  if (!value) {
    if (isProduction) {
      missing.push('ADMIN_SECRET_PATH')
      return ''
    }
    warn(`ADMIN_SECRET_PATH не задан — админка доступна по /${DEV_ADMIN_PATH}.`)
    return DEV_ADMIN_PATH
  }

  // Ведущий слэш отрезаем: в панели хостинга его пишут примерно в половине
  // случаев, а хранить путь нужно в одном виде, иначе роутер получит '//x'.
  const normalized = value.replace(/^\/+/, '').replace(/\/+$/, '')

  if (normalized.length < ADMIN_PATH_MIN) {
    fail(`ADMIN_SECRET_PATH короче ${ADMIN_PATH_MIN} символов (сейчас ${normalized.length}). ` +
      'Короткий «секретный» путь перебирается сканером за часы, длинный — нет. ' +
      'Сгенерируйте: node -e "console.log(require(\'node:crypto\').randomBytes(16).toString(\'hex\'))"')
  }
  if (!ADMIN_PATH_PATTERN.test(normalized)) {
    fail('ADMIN_SECRET_PATH может содержать только строчные латинские буквы, цифры и дефис, ' +
      `получено "${value}"`)
  }
  return normalized
}

const readAllowedOrigins = (publicOrigin) => {
  try {
    return buildAllowedOrigins({
      publicOrigin,
      extraOrigins: raw('ALLOWED_ORIGINS'),
      allowHttp: !isProduction,
    })
  } catch (error) {
    return fail(error.message)
  }
}

// Осознанный отказ от прокси. Пустая переменная и слово 'none' дают одинаковый
// пустой список, но означают разное: первое — «не подумали», второе — «процесс
// смотрит в интернет напрямую». Различие проверяет assertProductionConfig.
const DIRECT_EXPOSURE = 'none'

const isDirectlyExposed = raw('TRUSTED_PROXY_CIDRS').trim().toLowerCase() === DIRECT_EXPOSURE

const readTrustedProxyCidrs = () => {
  if (isDirectlyExposed) return compileTrustedProxyCidrs('')
  try {
    return compileTrustedProxyCidrs(raw('TRUSTED_PROXY_CIDRS'))
  } catch (error) {
    return fail(`TRUSTED_PROXY_CIDRS: ${error.message}`)
  }
}

// Форма токена @BotFather: '<id бота>:<секрет>'. Точное значение проверить
// нечем, но обрезанный при копировании хвост и вставленный не туда chat_id
// эта проверка ловит.
const BOT_TOKEN_SHAPE = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/

/**
 * Список имён хостов, за которые сервер отвечает.
 *
 * Нужен против DNS rebinding: чужое имя резолвится на наш адрес, браузер
 * считает наши ответы same-origin с этим именем и читает их со страницы
 * атакующего. По сокету такой запрос неотличим от обычного — отличается
 * только authority, поэтому его и проверяем.
 *
 * PUBLIC_ORIGIN входит всегда; TRUSTED_HOSTS только добавляет имена (health
 * check по 127.0.0.1, второй домен, технический поддомен) и не может
 * отключить основное. Пустой список не значит «пускать всех»: он не совпадает
 * ни с чем, и это верное поведение для не заданного PUBLIC_ORIGIN.
 */
const readTrustedHosts = (publicOrigin) => {
  const values = []
  if (publicOrigin) values.push(new URL(publicOrigin).host)
  // Вне прода сайт открывают и по localhost, и по 127.0.0.1, и по [::1],
  // причём на порту, который Vite выбирает сам. Перечислять это руками
  // значило бы ломать локальный запуск ради проверки, которой в dev
  // нечего защищать: рядом нет ни чужого домена, ни чужого браузера.
  if (!isProduction) values.push('localhost', '127.0.0.1', '[::1]')
  values.push(...raw('TRUSTED_HOSTS').split(','))

  try {
    return compileAllowedHosts(values)
  } catch (error) {
    return fail(`TRUSTED_HOSTS: ${error.message}`)
  }
}

const readTelegramApiBase = () => {
  const value = raw('TELEGRAM_API_BASE')
  if (!value) return DEFAULT_TELEGRAM_API
  // Локальная заглушка (scripts/mock-telegram.mjs) работает по http, поэтому
  // формат проверяем мягко, а опасность подмены ловит assertProductionConfig.
  return parseOrigin('TELEGRAM_API_BASE', value, { allowHttp: true })
}

const port = readInt('PORT', 3000, 1, 65535)
const sessionIdleMin = readInt('SESSION_IDLE_MIN', 30, 1, 1440)
const sessionAbsoluteH = readInt('SESSION_ABSOLUTE_H', 12, 1, 720)
if (sessionIdleMin >= sessionAbsoluteH * 60) {
  fail(`SESSION_IDLE_MIN (${sessionIdleMin} мин) не меньше SESSION_ABSOLUTE_H ` +
    `(${sessionAbsoluteH} ч) — абсолютный срок жизни сессии никогда не сработает`)
}

const mediaQuotaBytes = readInt('MEDIA_QUOTA_BYTES', 300 * MB, MB, 100_000 * MB)
// На тарифе 500 МБ под всё: код, node_modules, SQLite и загруженные файлы.
// Квота больше ~450 МБ означает, что диск кончится раньше квоты и запись
// начнёт падать в неожиданных местах вместо честного «превышена квота».
if (mediaQuotaBytes > 450 * MB) {
  warn(`MEDIA_QUOTA_BYTES = ${Math.round(mediaQuotaBytes / MB)} МБ при диске в 500 МБ — ` +
    'место кончится раньше квоты')
}

const dataDirRaw = raw('DATA_DIR') || './data'
// Абсолютный путь: Passenger запускает процесс из корня приложения, но cron
// и ручной запуск — откуда угодно, и относительный путь дал бы вторую базу.
const dataDir = resolve(process.cwd(), dataDirRaw)

const telegramApiBase = readTelegramApiBase()
// Предупреждение во ВСЕХ режимах, а не только в проде. Подменённый адрес —
// единственная конфигурация, при которой всё зелёное: заглушка отвечает
// «доставлено» на любой запрос, заявка получает статус sent, а в рабочем чате
// пусто. Прод такой запуск отвергает (assertProductionConfig), но искать
// причину приходилось именно в остальных режимах, где раньше не было ни строчки
// об этом. Строка печатается на каждом старте намеренно.
if (telegramApiBase !== DEFAULT_TELEGRAM_API) {
  warn(
    `TELEGRAM_API_BASE=${telegramApiBase} — заявки уходят СЮДА, а не в Telegram. ` +
      'В рабочем чате их не будет. Уберите переменную, чтобы вернуть ' +
      DEFAULT_TELEGRAM_API
  )
}
const publicOrigin = readPublicOrigin()

// HSTS. max-age задаётся отдельно от области действия, потому что откатить
// эти решения нельзя: браузер, однажды получивший заголовок, будет ходить
// только по https до истечения срока, и «выключить» директиву задним числом
// у уже побывавших на сайте посетителей невозможно.
const hstsMaxAge = readInt('HSTS_MAX_AGE', 31_536_000, 0, 63_072_000)
// includeSubDomains распространяет политику на ВСЕ поддомены апекса, включая
// чужие сервисы и внутренние стенды на том же домене. Это решение оператора,
// а не умолчание библиотеки, поэтому по умолчанию выключено.
const hstsIncludeSubDomains = readBool('HSTS_INCLUDE_SUBDOMAINS', false)
// preload вносит домен в список, зашитый в сборки браузеров: вычищается он
// месяцами и уже не зависит от того, что отдаёт сервер.
const hstsPreload = readBool('HSTS_PRELOAD', false)
if (hstsPreload && (!hstsIncludeSubDomains || hstsMaxAge < 31_536_000)) {
  fail('HSTS_PRELOAD=1 требует HSTS_INCLUDE_SUBDOMAINS=1 и HSTS_MAX_AGE не меньше 31536000 — ' +
    'иначе домен в список preload всё равно не примут, а заголовок уже необратим')
}

export const config = Object.freeze({
  nodeEnv,
  isProduction,
  port,
  dataDir,

  publicOrigin,
  allowedOrigins: readAllowedOrigins(publicOrigin),
  trustedProxyCidrs: readTrustedProxyCidrs(),
  trustedHosts: readTrustedHosts(publicOrigin),

  hsts: Object.freeze({
    maxAge: hstsMaxAge,
    includeSubDomains: hstsIncludeSubDomains,
    preload: hstsPreload,
  }),

  // Аналитика (GTM/GA) — отдельный выключатель, по умолчанию выключенный.
  // Пока он выключен, доменов аналитики нет и в CSP: разрешение, которым
  // никто не пользуется, — это только канал для чужого скрипта.
  analyticsEnabled: readBool('ANALYTICS_ENABLED', false),
  // Токен Stat API как умолчание деплоя. Настройка в реестре его перекрывает
  // (см. routes/admin.analytics.js): продлевать годовой токен должен уметь
  // человек с админкой, а не только с панелью хостинга.
  metricaOauthToken: raw('YANDEX_OAUTH_TOKEN'),

  appSecret: readSecret('APP_SECRET', DEV_APP_SECRET),
  gateSecret: readSecret('GATE_SECRET', DEV_GATE_SECRET),
  adminSecretPath: readAdminSecretPath(),

  // Secure by default: в проде вход в админку требует прохождения гейта,
  // локально это только мешает. Явное значение переменной сильнее умолчания.
  adminRequireGate: readBool('ADMIN_REQUIRE_GATE', isProduction),
  // Старый предсказуемый путь (/admin) — дыра, которую оставляют «на время
  // переезда». По умолчанию выключен всегда, включать осознанно и ненадолго.
  adminLegacyPathEnabled: readBool('ADMIN_LEGACY_PATH_ENABLED', false),

  sessionIdleMin,
  sessionAbsoluteH,
  // Готовые миллисекунды, чтобы каждый вызывающий не умножал сам и не ошибся
  // в множителе (минуты против часов — классика).
  sessionIdleMs: sessionIdleMin * 60_000,
  sessionAbsoluteMs: sessionAbsoluteH * 3_600_000,

  mediaQuotaBytes,

  telegramBotToken: raw('TELEGRAM_BOT_TOKEN'),
  telegramChatId: raw('TELEGRAM_CHAT_ID'),
  telegramApiBase,
  deeplApiKey: raw('DEEPL_API_KEY'),

  warnings: Object.freeze([...warnings]),
})

// Предупреждения печатаем один раз при загрузке модуля. В пуле Passenger
// строка появится столько раз, сколько поднято процессов, — это нормально
// и заодно показывает реальный размер пула.
for (const message of config.warnings) {
  console.warn(`[config] ${message}`)
}

/**
 * Проверка перед боевым стартом. Вызывать из app.cjs до начала обслуживания
 * запросов: сервер без секретов должен не подняться, а не выдавать сессии,
 * подписанные пустой строкой.
 *
 * Вне production ничего не делает — иначе локальный запуск и тесты требовали
 * бы боевых значений.
 */
export const assertProductionConfig = () => {
  if (!config.isProduction) return

  const problems = []

  for (const name of missing) {
    problems.push(`${name} не задан`)
  }

  // Дев-заглушка в проде страшнее отсутствующего значения: сервер бы поднялся
  // и работал с секретом, который лежит в открытом репозитории.
  const placeholders = [
    ['APP_SECRET', config.appSecret],
    ['GATE_SECRET', config.gateSecret],
    ['ADMIN_SECRET_PATH', config.adminSecretPath],
  ]
  for (const [name, value] of placeholders) {
    if (value.startsWith(DEV_PREFIX)) {
      problems.push(`${name} содержит дев-заглушку — замените на собственное значение`)
    }
  }

  if (config.appSecret && config.appSecret === config.gateSecret) {
    // Один ключ на две подсистемы означает, что токен гейта принимается
    // как сессионный и наоборот.
    problems.push('APP_SECRET и GATE_SECRET совпадают — нужны разные ключи')
  }

  // Подменённый адрес Bot API в проде = заявки уходят в никуда, а клиент
  // видит «успешно отправлено». Обычно это забытый в .env адрес заглушки.
  const apiUrl = new URL(config.telegramApiBase)
  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(apiUrl.hostname)
  if (apiUrl.protocol !== 'https:' || isLoopback) {
    problems.push(`TELEGRAM_API_BASE=${config.telegramApiBase} недопустим в проде — ` +
      `уберите переменную, чтобы использовать ${DEFAULT_TELEGRAM_API}`)
  }

  if (!config.telegramBotToken || !config.telegramChatId) {
    problems.push('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — заявки некуда отправлять')
  } else if (!BOT_TOKEN_SHAPE.test(config.telegramBotToken)) {
    // Раньше проверялась только непустота, и в поле годился любой мусор:
    // обрезанный при копировании хвост, лишний пробел, случайно вставленный
    // chat_id. Bot API отвечает на такое 401, но выясняется это первой
    // потерянной заявкой настоящего клиента, а не на старте.
    problems.push(
      'TELEGRAM_BOT_TOKEN не похож на токен от @BotFather (<id бота>:<секрет>) — ' +
        'проверьте, что скопирован он целиком'
    )
  }

  // ЗА ОБРАТНЫМ ПРОКСИ ЭТО НЕ НАСТРОЙКА, А ОБЯЗАННОСТЬ.
  //
  // Пустой список означает «доверять только адресу сокета». На Plesk/Passenger
  // сокет — это всегда сам прокси, поэтому X-Forwarded-For отбрасывается,
  // и ipHash у ВСЕХ посетителей получается одинаковый. Последствия тихие
  // и тяжёлые: лимит частоты становится общим на весь сайт, а первый же
  // сканер, дёрнувший honeypot-путь, блокирует этот общий хеш на сутки —
  // и весь сайт начинает отвечать пустой оболочкой uniform404.
  //
  // Молчаливое умолчание здесь недопустимо, поэтому выбор делается явно:
  // либо перечислить адреса прокси, либо написать TRUSTED_PROXY_CIDRS=none
  // и тем самым заявить, что процесс выставлен в интернет напрямую.
  if (!config.trustedProxyCidrs.length && !isDirectlyExposed) {
    problems.push(
      'TRUSTED_PROXY_CIDRS не задан. За обратным прокси (Plesk, nginx, Passenger) ' +
        'это делает адрес всех посетителей одинаковым: лимиты становятся общими, ' +
        'а одна сработавшая ловушка гасит сайт для всех на сутки. ' +
        'Укажите адреса прокси (обычно 127.0.0.1/32,::1/128) либо, если процесс ' +
        'смотрит в интернет напрямую, поставьте TRUSTED_PROXY_CIDRS=none'
    )
  }

  // Каталог данных проверяется здесь, а не при первом обращении к базе:
  // открытие БД намеренно не валит старт (CR-041, сервер поднимается
  // в ограниченном режиме), поэтому непригодный DATA_DIR выглядел бы
  // как «сайт работает», пока кто-нибудь не откроет админку.
  try {
    mkdirSync(config.dataDir, { recursive: true })
    accessSync(config.dataDir, fsConstants.W_OK)
  } catch (error) {
    problems.push(`DATA_DIR=${config.dataDir} недоступен для записи: ${error.message}`)
  }

  // База лежит рядом с заявками, хешами паролей и зашифрованными настройками.
  // Внутри каталога, который отдаёт веб-сервер, она скачивается по прямой
  // ссылке, и никакая проверка прав приложения этому не помешает.
  //
  // Перечислены именно каталоги сайта, а не любой сегмент со словом «www»:
  // на Plesk путь подписки выглядит как /var/www/vhosts/<домен>/, и проверка
  // по голому 'www' отвергала совершенно правильную раскладку, из-за чего
  // приложение не стартовало вовсе. Каталог по умолчанию у Apache — это
  // www/html, он и проверяется парой сегментов.
  if (/[/\\](httpdocs|public_html|htdocs|wwwroot|www[/\\]html)([/\\]|$)/i.test(config.dataDir)) {
    problems.push(
      `DATA_DIR=${config.dataDir} находится внутри каталога сайта — база с ` +
        'персональными данными будет доступна по прямой ссылке. Вынесите её выше'
    )
  }

  if (config.adminLegacyPathEnabled) {
    console.warn('[config] ADMIN_LEGACY_PATH_ENABLED=1 — предсказуемый путь админки открыт')
  }

  if (problems.length) {
    throw new Error(`[config] запуск в production невозможен:\n  - ${problems.join('\n  - ')}`)
  }
}
