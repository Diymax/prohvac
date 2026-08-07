// Разбор multipart/form-data — единственного формата тела, которым в админку
// попадают файлы. Без зависимостей: busboy и его родня тянут за собой
// собственные потоки, временные файлы и настройки, а нам нужен ровно один
// сценарий — «одна картинка и десяток коротких полей».
//
// ГЛАВНОЕ ПРАВИЛО, ТО ЖЕ ЧТО В server/http/body.js: лимит проверяется ПО ХОДУ
// чтения. Собрать тело целиком и посмотреть размер потом — это отказ
// в обслуживании: под Passenger процессов в пуле единицы, и пара параллельных
// «загрузок» по гигабайту выедает память раньше любой валидации. Поэтому
// байты, которые уже не влезают в лимит, в память не кладутся вообще: цикл
// прерывается до push, а выход из for await закрывает асинхронный итератор,
// то есть чтение сокета прекращается.
//
// Цена этого решения — оборванное соединение: клиент, приславший слишком
// большой файл, может не увидеть наш ответ 413. Это осознанный размен.
// Альтернатива — дочитать тело до конца ради красивого ответа, то есть
// позволить любому желающему бесплатно занимать процесс пула.
//
// РАЗБОР — КОНЕЧНЫЙ АВТОМАТ ПО БУФЕРУ. Тело приходит кусками произвольной
// длины, и граница (или заголовок части) запросто рвётся между двумя чанками.
// Поэтому состояние живёт снаружи цикла чтения, а из буфера всегда удерживается
// хвост длиной с границу минус один байт: короче нельзя — потеряем половину
// разделителя, длиннее незачем.
//
// Формат (RFC 2046 §5.1, RFC 7578):
//   [преамбула] CRLF--boundary CRLF заголовки CRLF CRLF тело
//   CRLF--boundary CRLF ... CRLF--boundary-- [эпилог]
// Обратите внимание: CRLF перед разделителем принадлежит разделителю, а не
// телу части. Первому разделителю CRLF может и не предшествовать (тело
// начинается прямо с '--boundary'), поэтому разбор стартует с искусственного
// CRLF в буфере — тогда шаблон поиска ровно один на все случаи.

const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')

const DASH = 0x2d
const SPACE = 0x20
const TAB = 0x09
const CR = 0x0d
const LF = 0x0a

// Сколько пробелов и табов допускается между разделителем и его CRLF.
// RFC 2046 называет это transport padding и длину не ограничивает; на практике
// его не ставит никто, а безразмерное поле — это способ заставить нас копить
// буфер, не начав ни одной части.
const MAX_PADDING = 32

/**
 * Значения по умолчанию. Вызывающий может ужесточить любое, но не ослабить
 * молча: сюда приходит не «настройка удобства», а граница, за которой процесс
 * начинает работать на атакующего.
 */
export const MULTIPART_LIMITS = Object.freeze({
  // Один файл и не больше четырёх мегабайт. Картинки в админку уходят уже
  // пережатыми в WebP, четыре мегабайта — это фотография с телефона без сжатия.
  maxFileBytes: 4 * 1024 * 1024,
  maxFields: 10,
  maxFieldBytes: 4 * 1024,
  // Блок заголовков одной части. Реальный — две строки по сотне байт;
  // всё, что больше, это попытка заставить нас копить буфер без границы.
  maxHeaderBytes: 2 * 1024,
  // Потолок на всё тело целиком. Нужен отдельно от maxFileBytes: преамбула,
  // эпилог и заголовки частей сами по себе ничем не ограничены, и без общего
  // предела можно было бы вечно лить «преамбулу», не начав ни одной части.
  maxTotalBytes: 4 * 1024 * 1024 + 64 * 1024,
  // Имя файла от клиента нигде не участвует в построении пути (см.
  // contentAddressedName в server/lib/image.js), но попадает в media.original_name
  // и в журнал, поэтому длину режем.
  maxFilenameLength: 200,
})

// Алфавит границы из RFC 2046: пробел разрешён внутри, но не последним
// символом, длина от 1 до 70. Проверка нужна не ради формализма — граница
// приходит из заголовка и дальше ищется в теле, и мусор в ней превратил бы
// разбор в поиск неизвестно чего.
const BOUNDARY_PATTERN =
  /^[0-9A-Za-z'()+_,\-./:=?](?:[0-9A-Za-z'()+_,\-./:=? ]{0,68}[0-9A-Za-z'()+_,\-./:=?])?$/

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

const fail = (error) => ({ ok: false, error, fields: null, file: null })

/**
 * Делит значение заголовка на основную часть и параметры по ';', НЕ трогая
 * содержимое кавычек: 'form-data; name="a;b"' — это один параметр со значением
 * 'a;b', а не два куска. Наивный split(';') здесь даёт разбор, которым можно
 * управлять снаружи.
 */
const splitSegments = (header) => {
  const segments = []
  let start = 0
  let quoted = false

  for (let i = 0; i < header.length; i += 1) {
    const char = header[i]

    if (quoted) {
      // Экранированный символ пропускаем целиком: '\"' — это кавычка внутри
      // значения, а не его конец.
      if (char === '\\') i += 1
      else if (char === '"') quoted = false
      continue
    }

    if (char === '"') quoted = true
    else if (char === ';') {
      segments.push(header.slice(start, i))
      start = i + 1
    }
  }

  segments.push(header.slice(start))
  return segments
}

/**
 * Снимает кавычки со значения параметра.
 *
 * Обратный слэш разэкранируется ТОЛЬКО перед кавычкой и перед самим собой.
 * Формально quoted-pair допускает любой символ, но клиенты (исторически —
 * браузеры под Windows) кладут в filename путь целиком: 'C:\Users\ivan\a.jpg'.
 * Разэкранирование всего подряд превратило бы его в 'C:Usersivana.jpg', то есть
 * стёрло бы разделители, по которым мы это имя и обрезаем до последнего сегмента.
 */
const unquote = (raw) => {
  const value = raw.trim()
  if (value.length < 2 || value[0] !== '"') return value

  let out = ''
  for (let i = 1; i < value.length; i += 1) {
    const char = value[i]
    if (char === '\\' && i + 1 < value.length) {
      const next = value[i + 1]
      if (next === '"' || next === '\\') {
        out += next
        i += 1
        continue
      }
      out += char
      continue
    }
    if (char === '"') break
    out += char
  }
  return out
}

/**
 * Разбирает заголовок вида 'multipart/form-data; boundary=abc'.
 * Возвращает { value, params } — value в нижнем регистре, параметры в объекте
 * без прототипа (значение параметра приходит от клиента и запросто окажется
 * '__proto__').
 */
export const parseHeaderValue = (header) => {
  const segments = splitSegments(typeof header === 'string' ? header : '')
  const params = Object.create(null)

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i]
    const eq = segment.indexOf('=')
    if (eq === -1) continue

    const name = segment.slice(0, eq).trim().toLowerCase()
    // Первое вхождение выигрывает: дубль параметра — это попытка показать
    // разным разборщикам разное значение (parameter smuggling).
    if (!name || name in params) continue
    // Внутри кавычек пробелы значимы, поэтому trim делает unquote и только
    // снаружи них: boundary="abc " — это не 'abc', а недопустимая граница.
    params[name] = unquote(segment.slice(eq + 1))
  }

  return { value: segments[0].trim().toLowerCase(), params }
}

/**
 * Граница из Content-Type.
 * @returns {{ok: true, boundary: string} | {ok: false, error: string}}
 */
export const parseBoundary = (contentType) => {
  const { value, params } = parseHeaderValue(contentType)
  if (value !== 'multipart/form-data') return { ok: false, error: 'unsupported_media_type' }

  const boundary = params.boundary ?? ''
  if (!BOUNDARY_PATTERN.test(boundary)) return { ok: false, error: 'invalid_boundary' }

  return { ok: true, boundary }
}

/**
 * Имя файла в том виде, в каком его не стыдно положить в базу и в лог.
 * В путь оно не попадает никогда (имя на диске даёт contentAddressedName),
 * но последний сегмент берём всё равно: клиент присылает и
 * 'C:\\Users\\ivan\\фото.jpg', и '../../app.cjs', и хранить это целиком незачем.
 */
const sanitizeFilename = (value, maxLength) => {
  const raw = typeof value === 'string' ? value : ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base.replace(CONTROL_CHARS, '').trim().slice(0, maxLength)
}

/**
 * Заголовки одной части в объект. null означает битый блок: строка без
 * двоеточия — это не заголовок, и дальше разбирать нечего.
 */
const collectHeaders = (raw) => {
  const headers = Object.create(null)

  for (const line of raw.split('\r\n')) {
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return null

    const name = line.slice(0, colon).trim().toLowerCase()
    if (!name || name in headers) continue
    headers[name] = line.slice(colon + 1).trim()
  }

  return headers
}

/**
 * Читает тело запроса как multipart/form-data.
 *
 * Возвращает { ok, error, fields, file }:
 *   fields — объект без прототипа, значения строками в UTF-8;
 *   file   — { buffer, filename, mimeType } либо null, если файла в теле нет.
 *
 * Коды ошибок (все snake_case, вызывающий сам решает, каким статусом отвечать):
 *   unsupported_media_type — Content-Type не multipart/form-data;
 *   invalid_boundary       — граница отсутствует или недопустима;
 *   payload_too_large      — тело целиком больше maxTotalBytes;
 *   file_too_large         — файл больше maxFileBytes;
 *   field_too_large        — значение поля больше maxFieldBytes;
 *   too_many_fields        — полей больше maxFields;
 *   too_many_files         — файлов в теле больше одного;
 *   headers_too_large      — блок заголовков части больше maxHeaderBytes;
 *   malformed_multipart    — тело оборвано или не соответствует формату;
 *   invalid_payload        — соединение сломалось на середине.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {Partial<typeof MULTIPART_LIMITS>} [options]
 */
export const readMultipart = async (req, options = {}) => {
  const limits = { ...MULTIPART_LIMITS, ...options }

  const parsed = parseBoundary(req?.headers?.['content-type'])
  if (!parsed.ok) return fail(parsed.error)

  // Content-Length пишет клиент, поэтому это не проверка, а короткий путь:
  // честному клиенту отвечаем сразу, не вычитывая тело в никуда. Настоящий
  // предел держит счётчик в цикле.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limits.maxTotalBytes) {
    return fail('payload_too_large')
  }

  // Шаблон поиска. CRLF впереди — часть разделителя, см. шапку файла.
  const needle = Buffer.concat([CRLF, Buffer.from(`--${parsed.boundary}`, 'latin1')])
  // Сколько байт удерживаем в буфере, когда разделитель не найден: ровно
  // столько, сколько может оказаться его началом.
  const keepBack = needle.length - 1

  const fields = Object.create(null)
  let file = null
  let fieldCount = 0

  // Искусственный CRLF: он делает первый разделитель неотличимым от остальных.
  let buffer = CRLF
  let state = 'preamble'
  // Куда вернуться, если найденная последовательность окажется не разделителем,
  // а совпадением внутри данных.
  let tailFrom = 'preamble'
  let part = null
  let finished = false

  /** Кладёт кусок тела текущей части, следя за её лимитом. */
  const write = (chunk) => {
    if (!chunk.length) return null

    const limit = part.isFile ? limits.maxFileBytes : limits.maxFieldBytes
    // Выходим ДО push: превысивший лимит кусок не должен осесть в памяти
    // даже на время формирования ответа.
    if (part.bytes + chunk.length > limit) {
      return part.isFile ? 'file_too_large' : 'field_too_large'
    }

    // Копия, а не подстрока общего буфера: subarray держит живой весь
    // ArrayBuffer, из которого он вырезан, и накопленные куски удерживали бы
    // в памяти в разы больше, чем сам файл.
    part.chunks.push(Buffer.from(chunk))
    part.bytes += chunk.length
    return null
  }

  /** Начинает часть по её разобранному блоку заголовков. */
  const startPart = (rawHeaders) => {
    const headers = collectHeaders(rawHeaders)
    if (!headers) return 'malformed_multipart'

    const disposition = headers['content-disposition']
    if (!disposition) return 'malformed_multipart'

    const { value, params } = parseHeaderValue(disposition)
    if (value !== 'form-data') return 'malformed_multipart'

    const name = params.name ?? ''
    if (!name) return 'malformed_multipart'

    const isFile = 'filename' in params
    // Второй файл отсекаем на заголовках, не дожидаясь его содержимого:
    // иначе лимит «один файл» стоил бы ещё четырёх мегабайт чтения.
    if (isFile && file) return 'too_many_files'

    if (!isFile) {
      fieldCount += 1
      if (fieldCount > limits.maxFields) return 'too_many_fields'
    }

    part = {
      isFile,
      name,
      filename: isFile ? sanitizeFilename(params.filename, limits.maxFilenameLength) : '',
      // Тип от клиента — не доказательство, а подсказка. Настоящий формат
      // определяется по байтам в server/lib/image.js.
      mimeType: (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      chunks: [],
      bytes: 0,
    }
    return null
  }

  /** Завершает часть: собирает её содержимое и сбрасывает состояние. */
  const closePart = () => {
    const current = part
    part = null

    if (!current.isFile) {
      // Первое значение выигрывает. Дубль имени — это попытка показать
      // серверу и логу разные значения одного поля.
      if (!(current.name in fields)) {
        fields[current.name] = Buffer.concat(current.chunks).toString('utf8')
      }
      return null
    }

    // Пустой <input type="file"> браузер всё равно отправляет — частью
    // с пустым именем и нулевым телом. Это «файла нет», а не файл.
    if (!current.filename && current.bytes === 0) return null

    file = {
      buffer: Buffer.concat(current.chunks),
      filename: current.filename,
      mimeType: current.mimeType,
    }
    return null
  }

  /**
   * Продвигает автомат по накопленному буферу.
   * Возвращает код ошибки, либо '' — «нужны новые данные или всё разобрано».
   */
  const advance = () => {
    for (;;) {
      if (state === 'preamble' || state === 'body') {
        const at = buffer.indexOf(needle)

        if (at === -1) {
          // Разделителя пока нет. Всё, кроме возможного его начала, можно
          // отдать текущей части (в преамбуле — просто выбросить).
          if (buffer.length > keepBack) {
            const ready = buffer.subarray(0, buffer.length - keepBack)
            if (state === 'body') {
              const error = write(ready)
              if (error) return error
            }
            buffer = buffer.subarray(buffer.length - keepBack)
          }
          return ''
        }

        if (state === 'body') {
          const error = write(buffer.subarray(0, at))
          if (error) return error
        }

        // Часть здесь ЕЩЁ НЕ закрывается: разделителем найденное станет только
        // после того, как за ним обнаружатся '--' или CRLF.
        buffer = buffer.subarray(at + needle.length)
        tailFrom = state
        state = 'tail'
        continue
      }

      if (state === 'tail') {
        // После разделителя стоит либо '--' (тело кончилось), либо CRLF,
        // возможно с пробелами-заполнителями перед ним.
        if (buffer.length < 2) return ''

        if (buffer[0] === DASH && buffer[1] === DASH) {
          if (part) {
            const closed = closePart()
            if (closed) return closed
          }
          finished = true
          return ''
        }

        let at = 0
        while (at < buffer.length && at < MAX_PADDING &&
               (buffer[at] === SPACE || buffer[at] === TAB)) {
          at += 1
        }
        // Заполнитель ещё не кончился, а данных больше нет — ждём продолжения.
        if (at < MAX_PADDING && at >= buffer.length) return ''

        if (buffer[at] === CR) {
          // CR на самом хвосте буфера: LF приедет со следующим чанком.
          if (at + 1 >= buffer.length) return ''
          if (buffer[at + 1] === LF) {
            if (part) {
              const closed = closePart()
              if (closed) return closed
            }
            buffer = buffer.subarray(at + 2)
            state = 'headers'
            continue
          }
        }

        // За совпадением нет ни '--', ни CRLF — значит это не разделитель,
        // а просто такие байты внутри данных. Возвращаем их в тело части
        // (в преамбуле — выбрасываем) и ищем дальше с текущей позиции:
        // повторного совпадения на том же месте быть не может, буфер уже
        // сдвинут за него, поэтому зацикливания здесь нет.
        if (tailFrom === 'body') {
          const error = write(needle)
          if (error) return error
        }
        state = tailFrom
        continue
      }

      // state === 'headers'
      const end = buffer.indexOf(HEADER_END)
      if (end === -1) {
        return buffer.length > limits.maxHeaderBytes ? 'headers_too_large' : ''
      }
      if (end > limits.maxHeaderBytes) return 'headers_too_large'

      // UTF-8, а не latin1: имя файла браузер шлёт байтами как есть,
      // и 'фото.jpg' обязано остаться собой.
      const rawHeaders = buffer.toString('utf8', 0, end)
      buffer = buffer.subarray(end + HEADER_END.length)

      const error = startPart(rawHeaders)
      if (error) return error

      state = 'body'
    }
  }

  let failure = ''
  let total = 0

  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > limits.maxTotalBytes) {
        failure = 'payload_too_large'
        break
      }

      // Закрывающий разделитель уже прочитан — дальше идёт эпилог, и его
      // содержимое нам безразлично. Но дочитать поток до конца ОБЯЗАТЕЛЬНО:
      // выход из for await закрывает итератор, а закрытие недочитанного
      // запроса рвёт сокет вместе с ещё не отправленным ответом.
      if (finished) continue

      buffer = Buffer.concat([buffer, chunk])

      failure = advance()
      // А вот здесь обрыв — ровно то, что нужно: выход из цикла закрывает
      // итератор, чтение сокета прекращается, и ни одного байта сверх лимита
      // мы больше не примем.
      if (failure) break
      // Разбор закончен: остаток буфера — эпилог, держать его незачем.
      if (finished) buffer = Buffer.alloc(0)
    }
  } catch {
    // Клиент отвалился или сокет сломался. Это не сбой сервера: тела просто
    // нет, и отвечать на него нечем.
    if (!failure) failure = 'invalid_payload'
  }

  if (failure) return fail(failure)
  // Поток кончился, а закрывающего разделителя не было: тело обрезано,
  // и «почти собранному» файлу верить нельзя.
  if (!finished) return fail('malformed_multipart')

  return { ok: true, error: null, fields, file }
}
