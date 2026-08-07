// Отдача собранного фронтенда из dist/. На Plesk перед Node стоит nginx,
// но раздачу статики он не берёт: Passenger проксирует в приложение всё,
// поэтому файлы отдаёт этот модуль.
//
// Здесь же живёт вся защита от выхода за пределы dist: путь приходит из URL,
// то есть целиком контролируется клиентом, и любая ошибка нормализации —
// это чтение произвольного файла с диска (app.cjs, .env, база SQLite).
//
// Разбор пути — только первая половина защиты. Вторая — файловая система:
// строка может не содержать ни одного '..' и всё равно указывать наружу,
// если по дороге лежит симлинк. Поэтому каждый отдаваемый файл проверяется
// не по имени, а по тому, что реально открылось, — см. openWithinRoot.

import { promises as fsp } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

import { securityHeaders, uniform404 } from './respond.js'

// Passenger стартует процесс из корня приложения, поэтому cwd здесь надёжен —
// та же логика, что и у DATA_DIR в server/config.js. Для нестандартного
// запуска (тесты, cron) корень можно передать явно через options.root.
export const DIST_DIR = resolve(process.cwd(), 'dist')

// Content-Type определяем по расширению и только по нему. Угадывать по
// содержимому нельзя: sniffing — это как раз то, что запрещает nosniff.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
}

// Расширения, для которых имеет смысл искать предсжатый вариант. Картинки
// и шрифты уже сжаты своим форматом: .br рядом с .webp дал бы больший файл
// и лишний такт процессора на распаковку.
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.xml', '.svg',
])

// Порядок фиксированный: brotli жмёт заметно плотнее gzip, а поддерживают его
// все браузеры, которые вообще открывают этот сайт.
const ENCODINGS = [
  { name: 'br', suffix: '.br' },
  { name: 'gzip', suffix: '.gz' },
]

// Экспортируется для вызывающих, у которых имя файла тоже content-addressed,
// но лежит он вне dist/assets — например, медиа из DATA_DIR (см. server/app.js).
export const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_STORE = 'no-store'
const REVALIDATE_HOURLY = 'public, max-age=3600'

/**
 * Разбирает Accept-Encoding с учётом q-весов.
 *
 * Явное упоминание кодировки сильнее '*': `br;q=0, *` означает «любую, кроме
 * brotli», и отдать brotli такому клиенту — отдать ему нечитаемый мусор.
 */
const acceptsEncoding = (header, name) => {
  if (typeof header !== 'string' || !header) return false

  let explicit = null
  let wildcard = null

  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().split(';')
    const coding = token.trim().toLowerCase()
    if (coding !== name && coding !== '*') continue

    const qParam = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='))
    const q = qParam ? Number(qParam.slice(2)) : 1
    const weight = Number.isFinite(q) ? q : 0

    if (coding === name) explicit = weight
    else wildcard = weight
  }

  return (explicit ?? wildcard ?? 0) > 0
}

/**
 * Превращает путь из URL в абсолютный путь внутри root либо возвращает null,
 * если запрос выглядит как попытка выйти наружу.
 */
const resolvePath = (root, urlPath) => {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    // Битый percent-encoding ('%zz') роняет decodeURIComponent в URIError.
    // Это не наша ошибка, а мусор от клиента.
    return null
  }

  // NUL обрезает строку в системных вызовах: 'index.html\0.png' открыл бы
  // index.html, пройдя проверку по расширению. Обратный слэш на Windows —
  // полноценный разделитель каталогов, и без этой проверки '..\..\app.cjs'
  // прошёл бы мимо разбора пути по '/'.
  if (decoded.includes('\0') || decoded.includes('\\')) return null

  const segments = decoded.split('/').filter(Boolean)
  if (!segments.length) return null

  // Сегмент, начинающийся с точки, отсекает разом и '..' (выход вверх),
  // и служебные файлы вроде .env или .git, которых в dist быть не должно,
  // но отдавать их по HTTP нельзя ни при каком стечении обстоятельств.
  if (segments.some((segment) => segment.startsWith('.'))) return null

  const full = join(root, ...segments)

  // Проверка вхождения в корень — вторая линия обороны. Формально после
  // фильтров выше выйти уже некуда, но цена ошибки здесь — чтение любого
  // файла на диске, поэтому результат сверяем с корнем явно.
  if (full !== root && !full.startsWith(root + sep)) return null

  return full
}

/** ETag из размера и mtime: содержимое файла ради заголовка читать не нужно. */
const etagFor = (stats) => `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`

/**
 * Сверка If-None-Match. W/-префикс снимаем: для целого файла слабое и сильное
 * сравнение дают один результат, а клиенты присылают и тот и другой вид.
 */
const etagMatches = (header, etag) => {
  if (typeof header !== 'string' || !header) return false
  if (header.trim() === '*') return true
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
}

const cacheControlFor = (urlPath, ext) => {
  // Имена в /assets/ содержат хеш содержимого (Vite), поэтому по одному URL
  // всегда лежит один и тот же байт-в-байт файл — можно кэшировать навсегда.
  if (urlPath.startsWith('/assets/')) return IMMUTABLE
  // HTML — точка входа: закэшированная старая оболочка ссылается на ассеты,
  // которых после релиза уже нет, и сайт «ломается до Ctrl+F5».
  if (ext === '.html') return NO_STORE
  return REVALIDATE_HOURLY
}

// Коды, которые означают ровно «по такому пути файла нет». Путь приходит
// из URL, поэтому сюда попадает и заведомый мусор: имя длиннее лимита FS,
// файл внутри файла ('/index.html/x'), кольцо симлинков. Всё это — обычный
// промах, а не сбой сервера, и отвечать на них 500 нельзя: получился бы
// способ отличить существующие пути от несуществующих по коду ответа.
// EISDIR добавлен ради гонки: между проверкой и open путь мог стать каталогом.
const MISSING_CODES = new Set([
  'ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP', 'EINVAL', 'EISDIR',
])

/** Обёртка над операцией с ФС: «нет файла» отделяется от сбоя ввода-вывода. */
const missingAsNull = async (operation) => {
  try {
    return await operation()
  } catch (error) {
    if (MISSING_CODES.has(error.code)) return null
    // EACCES и подобное — сломанные права на dist, то есть ошибка развёртывания.
    // Её нужно увидеть в логе, а не спрятать под 404.
    throw error
  }
}

/**
 * Реальный корень раздачи, с раскрытыми симлинками.
 *
 * Считается на каждый запрос и НЕ кэшируется намеренно: выкат переключает
 * document root сменой симлинка (см. scripts/build-release.mjs), и корень,
 * запомненный при старте, после релиза указывал бы на предыдущую сборку —
 * то есть проверка вхождения сверялась бы с каталогом, которого в раздаче
 * уже нет. Один realpath на запрос дешевле такого расхождения.
 */
const realRootOf = (root) => missingAsNull(() => fsp.realpath(root))

const withinRoot = (path, root) => path === root || path.startsWith(root + sep)

/** Один и тот же объект файловой системы, а не просто одно и то же имя. */
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

const closeQuietly = (handle) => {
  handle.close().catch((error) => {
    console.error(`[static] дескриптор не закрылся: ${error.message}`)
  })
}

/** Каталог по запрошенному пути существует — ответ на это отдельный. */
const DIRECTORY = Symbol('directory')

/**
 * Открывает файл и доказывает, что открыт именно тот объект, который лежит
 * внутри реального корня раздачи. Возвращает { handle, stats }, DIRECTORY
 * либо null.
 *
 * Порядок шагов и есть содержание функции:
 *
 *   1. lstat — НЕ идёт по симлинку. Симлинк в последнем сегменте отвергаем
 *      здесь же, целиком: в dist его кладёт только ошибка сборки, а в медиа
 *      попасть он может лишь от того, кто уже имеет запись в DATA_DIR.
 *   2. open — дальше клиенту уходит именно этот дескриптор. Всё, что
 *      случится с путём после, содержимого ответа уже не меняет.
 *   3. realpath — ловит симлинк в ПРОМЕЖУТОЧНОМ каталоге и любой другой
 *      способ оказаться снаружи: сравнение идёт с раскрытым корнем.
 *   4. сверка dev/ino дескриптора с тем, что видел lstat, — закрывает окно
 *      между шагами 1 и 2. Если путь подменили, открылся другой объект,
 *      и ответ мы не отдаём. Это и есть защита от TOCTOU в медиа, куда
 *      пишет админка: подмена перестаёт быть гонкой, которую можно выиграть,
 *      и превращается в 404.
 *
 * null означает ровно то же, что «файла нет». Отличать «симлинк» от «нет
 * файла» по ответу нельзя: разница в коде ответа сама по себе рассказывает
 * о содержимом каталога.
 */
const openWithinRoot = async (filePath, realRoot) => {
  const link = await missingAsNull(() => fsp.lstat(filePath))
  if (!link) return null
  if (link.isDirectory()) return DIRECTORY
  // Симлинк, сокет, устройство, FIFO — isFile() ложно для всех сразу.
  if (!link.isFile()) return null

  const handle = await missingAsNull(() => fsp.open(filePath, 'r'))
  if (!handle) return null

  const [stats, real] = await Promise.all([
    handle.stat(),
    missingAsNull(() => fsp.realpath(filePath)),
  ])

  if (!stats.isFile() || !sameFile(stats, link) || !real || !withinRoot(real, realRoot)) {
    closeQuietly(handle)
    return null
  }

  return { handle, stats }
}

/**
 * Ищет предсжатый вариант рядом с файлом. Возвращает { handle, stats, encoding }
 * либо null, если подходящего нет. Вариант проходит ровно ту же проверку, что
 * и основной файл: '.br' рядом с ассетом — такой же путь на диске.
 */
const pickVariant = async (filePath, acceptEncoding, realRoot) => {
  for (const { name, suffix } of ENCODINGS) {
    if (!acceptsEncoding(acceptEncoding, name)) continue
    const opened = await openWithinRoot(`${filePath}${suffix}`, realRoot)
    if (opened && opened !== DIRECTORY) return { ...opened, encoding: name }
  }
  return null
}

/**
 * Отдаёт содержимое уже открытого и проверенного дескриптора.
 *
 * Поток создаётся из дескриптора, а не из имени: повторное открытие по пути
 * означало бы, что проверки выше относились к другому файлу.
 */
const streamFile = (res, handle, label) => {
  // autoClose: false — дескриптор закрываем сами и ровно один раз, чтобы
  // владелец был один и не зависел от того, кто закончил первым. На пуле
  // процессов утечка fd упирается в лимит и начинает ронять уже посторонние
  // запросы, поэтому закрытие подвешено на все три исхода: файл дочитан,
  // чтение сорвалось, клиент ушёл раньше.
  //
  // Именно 'end', а не 'close': поток из FileHandle с autoClose: false
  // события 'close' не выдаёт вовсе — закрывать его некому, кроме нас.
  const stream = handle.createReadStream({ autoClose: false })
  let released = false
  const release = () => {
    if (released) return
    released = true
    closeQuietly(handle)
  }

  stream.on('error', (error) => {
    console.error(`[static] чтение ${label} оборвалось: ${error.message}`)
    release()
    // Заголовки с Content-Length уже ушли, сообщить об ошибке нечем.
    // Рвём соединение: пусть клиент увидит обрыв, а не примет обрезанный
    // файл за целый и не закэширует его.
    res.destroy()
  })

  stream.on('end', release)

  // Клиент отвалился на середине большого ассета — pipe за источником
  // не следит, поэтому поток и дескриптор закрываем руками.
  res.on('close', () => {
    stream.destroy()
    release()
  })

  stream.pipe(res)
}

/**
 * Пробует отдать файл из dist.
 *
 * Возвращает true, если ответ отправлен (включая 304 и uniform404),
 * и false — если подходящего файла нет и запрос должен уйти в SPA-роутер.
 *
 * options.root — корень раздачи, по умолчанию DIST_DIR.
 * options.cacheControl — готовое значение заголовка вместо правила по URL:
 *   правило знает только про dist (/assets/ — навсегда, остальное — на час),
 *   а у раздачи из другого корня свой срок жизни файлов.
 */
export const serveStatic = async (req, res, options = {}) => {
  const method = req.method
  if (method !== 'GET' && method !== 'HEAD') return false

  const root = options.root ? resolve(options.root) : DIST_DIR

  // Query и фрагмент к файлу на диске отношения не имеют; фрагмент браузер
  // и не присылает, но req.url может прийти и не от браузера.
  const urlPath = (req.url || '/').split('?')[0].split('#')[0]

  // Корень сайта — это маршрут SPA, а не файл. Отдаёт его spa.js, иначе
  // index.html поехал бы с кэшированием и без CSP-nonce.
  if (urlPath === '/') return false

  // Корень раскрываем до разбора пути: сравнивать вхождение нужно с реальным
  // каталогом, а не с именем, под которым он смонтирован или залинкован.
  const realRoot = await realRootOf(root)
  // Корня нет вовсе — сборку не выкладывали или DATA_DIR пуст. Отдавать нечего,
  // и это обычный промах, а не ошибка.
  if (!realRoot) return false

  const filePath = resolvePath(root, urlPath)
  if (!filePath) {
    // Попытка обхода каталога получает ровно тот же ответ, что и опечатка
    // в адресе: подтверждать, что защита сработала, незачем.
    await uniform404(req, res)
    return true
  }

  const opened = await openWithinRoot(filePath, realRoot)
  if (opened === DIRECTORY) {
    // Листинг каталога — это карта проекта в подарок. Отвечаем как на любой
    // неизвестный URL.
    await uniform404(req, res)
    return true
  }
  // Ничего пригодного: файла нет, либо путь ведёт наружу через симлинк, либо
  // объект подменили между проверкой и открытием. Для клиента всё это одно
  // и то же — «такого файла нет».
  if (!opened) return false

  const ext = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const compressible = COMPRESSIBLE.has(ext)

  const variant = compressible
    ? await pickVariant(filePath, req.headers['accept-encoding'], realRoot)
    : null

  let source = opened
  if (variant) {
    // Основной файл больше не нужен: клиенту уйдёт предсжатый вариант.
    closeQuietly(opened.handle)
    source = variant
  }

  // ETag считаем по тому файлу, который реально уходит клиенту: у .br и .gz
  // свои размер и mtime, поэтому варианты никогда не получат общий тег.
  const etag = etagFor(source.stats)

  securityHeaders(res)

  res.setHeader('ETag', etag)
  res.setHeader('Cache-Control', options.cacheControl || cacheControlFor(urlPath, ext))
  // Тело зависит от Accept-Encoding, и без Vary общий кэш отдал бы brotli
  // клиенту, который его не просил. Ставим для всех сжимаемых типов, даже
  // когда варианта не нашлось: завтра он появится, а кэш живёт долго.
  if (compressible) res.setHeader('Vary', 'Accept-Encoding')

  if (etagMatches(req.headers['if-none-match'], etag)) {
    closeQuietly(source.handle)
    res.statusCode = 304
    res.end()
    return true
  }

  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', String(source.stats.size))
  if (source.encoding) res.setHeader('Content-Encoding', source.encoding)

  if (method === 'HEAD') {
    closeQuietly(source.handle)
    res.end()
    return true
  }

  streamFile(res, source.handle, filePath)
  return true
}
