// Проверка загружаемых изображений по фактическому содержимому файла.
//
// Клиент жмёт картинки в браузере (canvas -> WebP), но ни имя файла, ни поле
// Content-Type в multipart не являются доказательством: и то и другое пишет
// отправитель. Единственный источник правды — байты заголовка, поэтому формат
// и размеры разбираются здесь вручную.
//
// Зависимостей нет намеренно: sharp/image-size тянут за собой бинарники и
// десятки мегабайт в node_modules, а на shared-хостинге с диском 500 МБ это
// непозволительно. Разбора заголовков достаточно — декодировать пиксели
// серверу не нужно.
//
// Все функции чистые и без состояния, поэтому модуль безопасен в пуле
// процессов Passenger: делить между ними тут нечего.

import { createHash } from 'node:crypto'

/** Значения по умолчанию; вызывающий код может ужесточить любое из них. */
export const DEFAULT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  allowedMimes: ['image/webp', 'image/avif', 'image/jpeg', 'image/png'],
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Сколько байт от начала файла смотрим при поиске XML-разметки.
const SVG_PROBE_BYTES = 1024

// Расширение выводим из распознанного mime, а не из присланного имени файла.
const EXTENSIONS = {
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

/** Принимаем Buffer и Uint8Array; последний оборачиваем без копирования. */
const toBuffer = (input) => {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  return null
}

/** Сравнение ASCII-тега (fourCC, имя чанка) с проверкой границ буфера. */
const tagAt = (buf, offset, tag) =>
  offset + tag.length <= buf.length && buf.toString('latin1', offset, offset + tag.length) === tag

/**
 * Единая точка сборки результата: отсекает нулевые и отрицательные размеры,
 * которые получаются из обрезанных или подделанных заголовков.
 */
const meta = (mime, width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if (width < 1 || height < 1) return null
  return { mime, width, height }
}

/**
 * SVG отклоняется всегда и не может быть разрешён через allowedMimes.
 * Это не растр, а XML: внутрь легально кладутся <script>, обработчики onload=
 * и ссылки на внешние ресурсы. Отданный браузеру с Content-Type image/svg+xml
 * такой файл исполняется в origin сайта — то есть загрузка «аватарки»
 * превращается в хранимый XSS. Разобрать SVG «безопасно» без полноценного
 * XML-парсера и санитайзера нельзя, поэтому формат просто не поддерживается.
 */
const looksLikeSvg = (buf) => {
  let text = buf.subarray(0, SVG_PROBE_BYTES).toString('latin1')
  // UTF-8 BOM в latin1 читается как три отдельных символа, trimStart его
  // не снимет — убираем руками, иначе проверка обходится добавлением BOM.
  if (text.startsWith('ï»¿')) text = text.slice(3)
  text = text.trimStart().toLowerCase()

  // Требуем, чтобы разметка была в самом начале файла. Иначе строка '<svg'
  // где-то в середине бинарника (например, в EXIF или в комментарии JPEG)
  // отклоняла бы совершенно нормальную картинку.
  if (!text.startsWith('<')) return false

  // Пролог <?xml, DOCTYPE или комментарий перед корневым элементом законны,
  // поэтому '<svg' не обязан стоять первым.
  return text.startsWith('<?xml') || text.startsWith('<!doctype svg') || text.includes('<svg')
}

/** VP8 (lossy): 3 байта frame tag, стартовый код 9D 01 2A, затем размеры. */
const parseVp8 = (buf, at, size) => {
  if (size < 10) return null
  // Размеры лежат только в заголовке ключевого кадра; его признак —
  // нулевой младший бит frame tag.
  if ((buf[at] & 1) !== 0) return null
  if (buf[at + 3] !== 0x9d || buf[at + 4] !== 0x01 || buf[at + 5] !== 0x2a) return null

  // По 14 бит на измерение, старшие 2 бита — коэффициент масштабирования,
  // к реальному размеру холста он отношения не имеет.
  return meta('image/webp', buf.readUInt16LE(at + 6) & 0x3fff, buf.readUInt16LE(at + 8) & 0x3fff)
}

/** VP8L (lossless): сигнатура 0x2F и одно 32-битное поле с размерами. */
const parseVp8l = (buf, at, size) => {
  if (size < 5) return null
  if (buf[at] !== 0x2f) return null

  // Раскладка поля: 14 бит ширины, 14 бит высоты, бит альфы, 3 бита версии.
  // Оба размера записаны уменьшенными на единицу, поэтому нуля тут не бывает.
  const bits = buf.readUInt32LE(at + 1)
  return meta('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
}

/** VP8X (extended): флаги и размер холста по 24 бита. */
const parseVp8x = (buf, at, size) => {
  if (size < 10) return null

  // Флаги(1) + резерв(3), дальше ширина и высота холста, обе минус единица.
  // Для VP8X авторитетен именно этот размер, а не размеры вложенных кадров.
  return meta('image/webp', buf.readUIntLE(at + 4, 3) + 1, buf.readUIntLE(at + 7, 3) + 1)
}

const parseWebp = (buf) => {
  // 12 байт контейнера RIFF + 8 байт заголовка первого чанка.
  if (buf.length < 20) return null
  if (!tagAt(buf, 0, 'RIFF') || !tagAt(buf, 8, 'WEBP')) return null

  // Поле размера RIFF считается от девятого байта. Если заявлено больше,
  // чем реально пришло, файл обрезан и его заголовкам верить нельзя.
  const riffSize = buf.readUInt32LE(4)
  if (riffSize < 12 || riffSize + 8 > buf.length) return null

  const fourCC = buf.toString('latin1', 12, 16)
  const chunkSize = buf.readUInt32LE(16)
  const at = 20
  if (chunkSize > buf.length - at) return null

  // Читаем строго первый чанк после 'WEBP' — по спецификации именно он
  // описывает изображение. Поиск VP8*-сигнатуры по всему файлу позволил бы
  // подсунуть валидатору размеры из чанка, который декодер никогда не откроет.
  if (fourCC === 'VP8 ') return parseVp8(buf, at, chunkSize)
  if (fourCC === 'VP8L') return parseVp8l(buf, at, chunkSize)
  if (fourCC === 'VP8X') return parseVp8x(buf, at, chunkSize)
  return null
}

const parseJpeg = (buf) => {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null

  let offset = 2
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) return null

    // Перед номером маркера допустимо любое число байт-заполнителей 0xFF.
    let cursor = offset + 1
    while (cursor < buf.length && buf[cursor] === 0xff) cursor += 1
    if (cursor >= buf.length) return null

    const marker = buf[cursor]
    offset = cursor + 1

    // 0xFF00 — экранированный байт данных, а не маркер: разбор сбился
    // с границы сегмента, дальше идти бессмысленно.
    if (marker === 0x00) return null

    // Маркеры без полезной нагрузки: TEM, повторный SOI и RST0..RST7.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue

    // SOS — дальше энтропийно кодированные данные, SOF уже не встретится.
    // EOI — конец изображения. В обоих случаях размеров мы не нашли.
    if (marker === 0xda || marker === 0xd9) return null

    if (offset + 2 > buf.length) return null
    const length = buf.readUInt16BE(offset)
    // Длина включает сами два байта длины, поэтому меньше двух не бывает.
    // Без этой проверки offset перестал бы расти и цикл завис бы.
    if (length < 2) return null

    // SOF0..SOF3: baseline, extended sequential, progressive и lossless.
    // Раскладка одинаковая: длина(2) + точность(1) + высота(2) + ширина(2).
    if (marker >= 0xc0 && marker <= 0xc3) {
      if (length < 7 || offset + 7 > buf.length) return null
      return meta('image/jpeg', buf.readUInt16BE(offset + 5), buf.readUInt16BE(offset + 3))
    }

    offset += length
  }

  return null
}

const parsePng = (buf) => {
  // 8 байт сигнатуры + 4 длины + 4 имени чанка + 4 ширины + 4 высоты.
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null

  // IHDR обязан быть первым чанком и иметь длину ровно 13 байт.
  if (buf.readUInt32BE(8) !== 13 || !tagAt(buf, 12, 'IHDR')) return null

  return meta('image/png', buf.readUInt32BE(16), buf.readUInt32BE(20))
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const AVIF_CONTAINER_BOXES = new Set(['meta', 'iprp', 'ipco'])

const boxSizeAt = (buf, offset, end) => {
  if (offset + 8 > end) return null
  const shortSize = buf.readUInt32BE(offset)
  if (shortSize === 0) return { size: end - offset, header: 8 }
  if (shortSize !== 1) return shortSize >= 8 ? { size: shortSize, header: 8 } : null
  if (offset + 16 > end) return null
  const longSize = buf.readBigUInt64BE(offset + 8)
  if (longSize > BigInt(Number.MAX_SAFE_INTEGER) || longSize < 16n) return null
  return { size: Number(longSize), header: 16 }
}

/**
 * AVIF is an ISO-BMFF container. Dimensions live in an `ispe` property,
 * nested under meta/iprp/ipco. Walking box boundaries (instead of searching
 * raw bytes) prevents a fake `ispe` string inside media payload from
 * bypassing the dimension limit.
 */
const parseAvifBoxes = (buf, start, end, depth = 0) => {
  if (depth > 6) return null
  let offset = start
  while (offset < end) {
    const parsedSize = boxSizeAt(buf, offset, end)
    if (!parsedSize || offset + parsedSize.size > end) return null
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const payload = offset + parsedSize.header

    if (type === 'ispe') {
      // FullBox flags(4), width(4), height(4).
      if (parsedSize.size < parsedSize.header + 12) return null
      return meta('image/avif', buf.readUInt32BE(payload + 4), buf.readUInt32BE(payload + 8))
    }

    if (AVIF_CONTAINER_BOXES.has(type)) {
      const childStart = type === 'meta' ? payload + 4 : payload
      if (childStart > offset + parsedSize.size) return null
      const found = parseAvifBoxes(buf, childStart, offset + parsedSize.size, depth + 1)
      if (found) return found
    }
    offset += parsedSize.size
  }
  return null
}

const parseAvif = (buf) => {
  if (buf.length < 24) return null
  const first = boxSizeAt(buf, 0, buf.length)
  if (!first || buf.toString('latin1', 4, 8) !== 'ftyp' || first.size < first.header + 8) {
    return null
  }

  const brandEnd = first.size
  let recognized = AVIF_BRANDS.has(buf.toString('latin1', first.header, first.header + 4))
  for (let offset = first.header + 8; !recognized && offset + 4 <= brandEnd; offset += 4) {
    recognized = AVIF_BRANDS.has(buf.toString('latin1', offset, offset + 4))
  }
  if (!recognized) return null

  return parseAvifBoxes(buf, first.size, buf.length)
}

/**
 * Определяет формат по заголовку. Возвращает { mime, width, height }
 * либо null, если это не поддерживаемое изображение.
 */
export const sniffImage = (input) => {
  const buf = toBuffer(input)
  if (!buf || buf.length === 0) return null
  // SVG отсекаем до разбора: он не должен получить ни mime, ни размеры.
  if (looksLikeSvg(buf)) return null

  return parseWebp(buf) || parseAvif(buf) || parseJpeg(buf) || parsePng(buf)
}

const fail = (error) => ({ ok: false, error, meta: null })

/**
 * Полная проверка загрузки: размер файла, формат, mime и габариты.
 * Возвращает { ok, error, meta }; error — код в snake_case либо null.
 */
export const validateUpload = (input, options = {}) => {
  const opts = options || {}
  const maxBytes = opts.maxBytes ?? DEFAULT_LIMITS.maxBytes
  const maxWidth = opts.maxWidth ?? DEFAULT_LIMITS.maxWidth
  const maxHeight = opts.maxHeight ?? DEFAULT_LIMITS.maxHeight
  const allowedMimes = opts.allowedMimes ?? DEFAULT_LIMITS.allowedMimes

  const buf = toBuffer(input)
  if (!buf || buf.length === 0) return fail('not_an_image')

  // Размер проверяем первым: это самая дешёвая проверка, и она ограничивает
  // объём данных, который дальше вообще придётся просматривать.
  if (buf.length > maxBytes) return fail('too_large')

  // Отдельная ветка до sniffImage: SVG нужно отклонить с внятным кодом,
  // а не смешивать с произвольным мусором, и сделать это независимо от того,
  // что перечислено в allowedMimes.
  if (looksLikeSvg(buf)) return fail('unsupported_mime')

  const found = sniffImage(buf)
  if (!found) return fail('not_an_image')

  if (!allowedMimes.includes(found.mime)) {
    return { ok: false, error: 'unsupported_mime', meta: found }
  }

  // Габариты проверяются по заголовку, а не по размеру файла: «бомба»
  // вроде 50000x50000 в PNG весит килобайты, но кладёт любой обработчик.
  if (found.width > maxWidth || found.height > maxHeight) {
    return { ok: false, error: 'dimensions_too_large', meta: found }
  }

  return { ok: true, error: null, meta: found }
}

/**
 * Имя файла на диске = первые 16 hex от sha256 содержимого + расширение.
 *
 * Имя генерирует сервер, а не клиент, и это разом закрывает три вещи:
 *   - path traversal: в выводе только [0-9a-f] и одна точка, поэтому
 *     '../../app.cjs' или NUL-байт в имени физически неоткуда взяться;
 *   - подмену расширения: суффикс берётся из распознанного по байтам mime,
 *     а не из присланного имени, так что 'avatar.jpg.php' не появится;
 *   - дубликаты: одинаковое содержимое даёт одинаковое имя, файл просто
 *     перезаписывается сам собой и место на диске не тратится дважды.
 *
 * 16 hex — это 64 бита: коллизия становится вероятной примерно на 4 млрд
 * файлов, что для лендинга запас на порядки.
 */
export const contentAddressedName = (input, mime) => {
  const buf = toBuffer(input)
  if (!buf) throw new TypeError('contentAddressedName: ожидается Buffer или Uint8Array')

  const ext = EXTENSIONS[mime]
  if (!ext) throw new TypeError(`contentAddressedName: неподдерживаемый mime «${mime}»`)

  return `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`
}
