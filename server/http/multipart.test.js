import { describe, expect, it } from 'vitest'

import { MULTIPART_LIMITS, parseBoundary, readMultipart } from './multipart.js'

// Тела собираем здесь же, байт в байт по RFC: фикстуры на диске прятали бы
// именно то, что проверяется, — CRLF перед разделителем и его финальные '--'.

const BOUNDARY = '----prohvacBoundaryQ1w2e3'

const field = (name, value) => ({
  headers: [`Content-Disposition: form-data; name="${name}"`],
  body: Buffer.from(String(value), 'utf8'),
})

const filePart = (name, filename, type, body) => ({
  headers: [
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"`,
    `Content-Type: ${type}`,
  ],
  body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'),
})

/** Собранное тело multipart. closing: false обрывает его без '--boundary--'. */
const buildBody = (parts, { closing = true, preamble = '' } = {}) => {
  const chunks = preamble ? [Buffer.from(preamble, 'utf8')] : []

  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`, 'latin1'))
    chunks.push(Buffer.from(`${part.headers.join('\r\n')}\r\n\r\n`, 'utf8'))
    chunks.push(part.body)
    chunks.push(Buffer.from('\r\n', 'latin1'))
  }

  if (closing) chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'latin1'))
  return Buffer.concat(chunks)
}

/**
 * Запрос-заглушка. state.aborted показывает, что читатель вышел из цикла
 * досрочно (for await закрыл итератор) — именно так выглядит обрыв потока
 * на превышении лимита.
 */
const request = (payload, options = {}) => {
  const {
    chunkSize = payload.length || 1,
    contentType = `multipart/form-data; boundary=${BOUNDARY}`,
    contentLength = null,
  } = options

  const state = { delivered: 0, drained: false, aborted: false }
  const headers = { 'content-type': contentType }
  if (contentLength !== null) headers['content-length'] = String(contentLength)

  return {
    state,
    headers,
    async *[Symbol.asyncIterator]() {
      try {
        for (let at = 0; at < payload.length; at += chunkSize) {
          const chunk = payload.subarray(at, at + chunkSize)
          state.delivered += chunk.length
          yield chunk
        }
        state.drained = true
      } finally {
        state.aborted = !state.drained
      }
    },
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

describe('parseBoundary', () => {
  it('достаёт границу из Content-Type, в том числе в кавычках', () => {
    expect(parseBoundary('multipart/form-data; boundary=abc123')).toEqual({
      ok: true,
      boundary: 'abc123',
    })
    expect(parseBoundary('Multipart/Form-Data; BOUNDARY="a b c"')).toEqual({
      ok: true,
      boundary: 'a b c',
    })
    expect(parseBoundary('multipart/form-data; charset=utf-8; boundary=xyz')).toMatchObject({
      boundary: 'xyz',
    })
  })

  it('отвергает чужой тип и негодную границу', () => {
    expect(parseBoundary('application/json')).toEqual({
      ok: false,
      error: 'unsupported_media_type',
    })
    expect(parseBoundary(undefined)).toEqual({ ok: false, error: 'unsupported_media_type' })
    expect(parseBoundary('multipart/form-data')).toEqual({ ok: false, error: 'invalid_boundary' })
    expect(parseBoundary('multipart/form-data; boundary=')).toEqual({
      ok: false,
      error: 'invalid_boundary',
    })
    // Пробел последним символом запрещён RFC 2046, и это не придирка:
    // такую границу разные разборщики режут по-разному.
    expect(parseBoundary('multipart/form-data; boundary="abc "')).toEqual({
      ok: false,
      error: 'invalid_boundary',
    })
    expect(parseBoundary(`multipart/form-data; boundary=${'a'.repeat(71)}`)).toEqual({
      ok: false,
      error: 'invalid_boundary',
    })
  })
})

describe('readMultipart — простое тело', () => {
  it('разбирает поля и один файл', async () => {
    const payload = buildBody([
      field('title', 'Крыша ТРЦ'),
      filePart('file', 'фото.png', 'image/png', PNG),
      field('alt', 'подпись'),
    ])

    const result = await readMultipart(request(payload))

    expect(result.ok).toBe(true)
    expect(result.error).toBe(null)
    expect({ ...result.fields }).toEqual({ title: 'Крыша ТРЦ', alt: 'подпись' })
    expect(result.file.filename).toBe('фото.png')
    expect(result.file.mimeType).toBe('image/png')
    expect(result.file.buffer.equals(PNG)).toBe(true)
    // Тело дочитано до конца: иначе закрытие итератора порвало бы сокет
    // вместе с ещё не отправленным ответом.
    expect(request(payload).state.aborted).toBe(false)
  })

  it('пропускает преамбулу и эпилог', async () => {
    const payload = Buffer.concat([
      buildBody([field('a', '1')], { preamble: 'это текст для клиента без multipart\r\n' }),
      Buffer.from('эпилог, который никого не касается', 'utf8'),
    ])

    const result = await readMultipart(request(payload))
    expect(result.ok).toBe(true)
    expect({ ...result.fields }).toEqual({ a: '1' })
  })

  it('не путает начало границы внутри файла с самой границей', async () => {
    // В содержимом есть и CRLF, и '--boundary' без завершающего CRLF,
    // и одинокие дефисы: всё это обязано остаться данными.
    const tricky = Buffer.from(
      `\r\n--${BOUNDARY}x\r\n--${BOUNDARY.slice(0, 8)}\r\n--\r\n`,
      'latin1'
    )
    const payload = buildBody([filePart('file', 'a.bin', 'application/octet-stream', tricky)])

    const result = await readMultipart(request(payload, { chunkSize: 5 }))

    expect(result.ok).toBe(true)
    expect(result.file.buffer.equals(tricky)).toBe(true)
  })

  it('очищает имя файла от пути и служебных символов', async () => {
    const payload = buildBody([
      filePart('file', 'C:\\Users\\ivan\\..\\..\\app.cjs', 'image/png', PNG),
    ])

    const result = await readMultipart(request(payload))
    expect(result.file.filename).toBe('app.cjs')
  })

  it('не даёт полю с именем __proto__ испортить прототип', async () => {
    const payload = buildBody([field('__proto__', 'polluted'), field('ok', '1')])

    const result = await readMultipart(request(payload))

    expect(result.ok).toBe(true)
    expect(Object.getPrototypeOf(result.fields)).toBe(null)
    expect(result.fields.__proto__).toBe('polluted')
    expect({}.polluted).toBeUndefined()
  })

  it('оставляет первое значение при дубле имени поля', async () => {
    const payload = buildBody([field('lang', 'ru'), field('lang', 'en')])

    const result = await readMultipart(request(payload))
    expect(result.fields.lang).toBe('ru')
  })

  it('считает пустой <input type="file"> отсутствием файла', async () => {
    const payload = buildBody([
      { headers: ['Content-Disposition: form-data; name="file"; filename=""'], body: Buffer.alloc(0) },
      field('a', '1'),
    ])

    const result = await readMultipart(request(payload))
    expect(result.ok).toBe(true)
    expect(result.file).toBe(null)
  })
})

describe('readMultipart — граница, разорванная между чанками', () => {
  const payload = buildBody([
    field('title', 'значение с CRLF\r\nвнутри'),
    filePart('file', 'photo.png', 'image/png', PNG),
  ])

  // 1 байт — вырожденный случай: разделитель, заголовки и '--' в конце
  // приходят по одному символу. Остальные размеры выбраны так, чтобы разрез
  // попадал в середину границы, а не только на её края.
  for (const chunkSize of [1, 2, 3, 7, 11, 64, payload.length - 1]) {
    it(`собирает то же самое при чанках по ${chunkSize} байт`, async () => {
      const result = await readMultipart(request(payload, { chunkSize }))

      expect(result.ok).toBe(true)
      expect(result.fields.title).toBe('значение с CRLF\r\nвнутри')
      expect(result.file.buffer.equals(PNG)).toBe(true)
      expect(result.file.filename).toBe('photo.png')
    })
  }

  it('не теряет данные, когда тело приходит одним куском с эпилогом', async () => {
    const withEpilogue = Buffer.concat([payload, Buffer.from('\r\n\r\n', 'latin1')])
    const result = await readMultipart(request(withEpilogue))
    expect(result.file.buffer.equals(PNG)).toBe(true)
  })
})

describe('readMultipart — лимиты', () => {
  it('рвёт поток, когда файл больше лимита', async () => {
    const big = Buffer.alloc(64 * 1024, 0x61)
    const payload = buildBody([filePart('file', 'big.bin', 'image/png', big)])
    const req = request(payload, { chunkSize: 1024 })

    const result = await readMultipart(req, { maxFileBytes: 4 * 1024 })

    expect(result).toEqual({ ok: false, error: 'file_too_large', fields: null, file: null })
    // Главное: чтение прекращено, остаток тела в процесс не попал.
    expect(req.state.aborted).toBe(true)
    expect(req.state.delivered).toBeLessThan(payload.length)
  })

  it('рвёт поток, когда значение поля больше лимита', async () => {
    const payload = buildBody([field('note', 'x'.repeat(8 * 1024))])
    const req = request(payload, { chunkSize: 512 })

    const result = await readMultipart(req, { maxFieldBytes: 1024 })

    expect(result.error).toBe('field_too_large')
    expect(req.state.aborted).toBe(true)
  })

  it('режет тело целиком по maxTotalBytes', async () => {
    // Файл в лимит укладывается, а вот преамбула — нет.
    const payload = Buffer.concat([
      Buffer.from('x'.repeat(32 * 1024), 'latin1'),
      buildBody([filePart('file', 'a.png', 'image/png', PNG)]),
    ])
    const req = request(payload, { chunkSize: 4096 })

    const result = await readMultipart(req, { maxTotalBytes: 8 * 1024 })

    expect(result.error).toBe('payload_too_large')
    expect(req.state.aborted).toBe(true)
  })

  it('отвечает по Content-Length, не читая тело вовсе', async () => {
    const payload = buildBody([field('a', '1')])
    const req = request(payload, { contentLength: MULTIPART_LIMITS.maxTotalBytes + 1 })

    const result = await readMultipart(req)

    expect(result.error).toBe('payload_too_large')
    expect(req.state.delivered).toBe(0)
  })

  it('считает поля и отвергает лишние', async () => {
    const parts = []
    for (let i = 0; i < 12; i += 1) parts.push(field(`f${i}`, i))
    const req = request(buildBody(parts), { chunkSize: 32 })

    const result = await readMultipart(req, { maxFields: 10 })

    expect(result.error).toBe('too_many_fields')
    expect(req.state.aborted).toBe(true)
  })

  it('принимает ровно maxFields полей', async () => {
    const parts = []
    for (let i = 0; i < 10; i += 1) parts.push(field(`f${i}`, i))

    const result = await readMultipart(request(buildBody(parts)), { maxFields: 10 })
    expect(result.ok).toBe(true)
    expect(Object.keys(result.fields)).toHaveLength(10)
  })

  it('отвергает второй файл на его заголовках', async () => {
    const payload = buildBody([
      filePart('cover', 'a.png', 'image/png', PNG),
      filePart('extra', 'b.png', 'image/png', Buffer.alloc(1024, 0x62)),
    ])
    const req = request(payload, { chunkSize: 16 })

    const result = await readMultipart(req)

    expect(result.error).toBe('too_many_files')
    expect(req.state.aborted).toBe(true)
  })

  it('не копит бесконечный блок заголовков', async () => {
    const payload = buildBody([
      {
        headers: [
          'Content-Disposition: form-data; name="a"',
          `X-Padding: ${'p'.repeat(8 * 1024)}`,
        ],
        body: Buffer.from('1'),
      },
    ])
    const req = request(payload, { chunkSize: 1024 })

    const result = await readMultipart(req, { maxHeaderBytes: 512 })

    expect(result.error).toBe('headers_too_large')
    expect(req.state.aborted).toBe(true)
  })
})

describe('readMultipart — битые тела', () => {
  it('не принимает тело без закрывающего разделителя', async () => {
    const payload = buildBody([filePart('file', 'a.png', 'image/png', PNG)], { closing: false })

    const result = await readMultipart(request(payload))
    expect(result.error).toBe('malformed_multipart')
    expect(result.file).toBe(null)
  })

  it('не принимает часть без Content-Disposition и без имени', async () => {
    const noDisposition = buildBody([{ headers: ['Content-Type: text/plain'], body: Buffer.from('1') }])
    expect((await readMultipart(request(noDisposition))).error).toBe('malformed_multipart')

    const noName = buildBody([{ headers: ['Content-Disposition: form-data'], body: Buffer.from('1') }])
    expect((await readMultipart(request(noName))).error).toBe('malformed_multipart')
  })

  it('не принимает мусор вместо заголовков', async () => {
    const payload = buildBody([{ headers: ['просто строка без двоеточия'], body: Buffer.from('1') }])
    expect((await readMultipart(request(payload))).error).toBe('malformed_multipart')
  })

  it('переживает обрыв соединения на середине', async () => {
    const req = {
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error('socket hang up')
      },
    }

    expect((await readMultipart(req)).error).toBe('invalid_payload')
  })

  it('не разбирает тело чужого типа', async () => {
    const payload = buildBody([field('a', '1')])
    const req = request(payload, { contentType: 'application/json' })

    expect((await readMultipart(req)).error).toBe('unsupported_media_type')
    expect(req.state.delivered).toBe(0)
  })
})
