// Чтение тела запроса. Node тело не разбирает и не ограничивает: обработчик
// получает поток, из которого можно вычитать сколько угодно.
//
// Отсюда главное правило модуля: лимит проверяется ПО ХОДУ чтения, а не после.
// Вариант «собрать всё, потом посмотреть длину» — готовый отказ в
// обслуживании: несколько параллельных запросов по гигабайту выедают память
// процесса раньше, чем дело дойдёт до любой валидации, а на shared-хостинге
// с пулом процессов это кладёт весь сайт.

// 8 КБ с запасом покрывают заявку с сообщением на 1000 символов (правила
// в shared/lead.js). Всё, что больше, — либо ошибка клиента, либо попытка.
export const DEFAULT_JSON_LIMIT = 8 * 1024

const fail = (error) => ({ ok: false, value: null, error })

/**
 * JSON.parse кладёт ключ '__proto__' в объект как обычное собственное
 * свойство — само по себе это безопасно. Опасно следующее действие: стоит
 * скопировать такой объект спредом или Object.assign в другой, и прототип
 * цели подменён на пришедший от клиента. Выбрасываем ключ на входе,
 * чтобы дальше по коду об этом можно было не помнить.
 */
const dropProto = (key, value) => (key === '__proto__' ? undefined : value)

/**
 * Читает тело запроса и разбирает его как JSON-объект.
 *
 * Возвращает { ok, value, error }:
 *   - payload_too_large — тело превысило лимит (отвечать 413);
 *   - invalid_payload   — пусто, не JSON, не объект или соединение оборвалось
 *                         (отвечать 400).
 *
 * options.limit — предел в байтах, по умолчанию DEFAULT_JSON_LIMIT.
 */
export const readJson = async (req, options = {}) => {
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_JSON_LIMIT

  // Content-Length клиент пишет сам, поэтому это не проверка, а короткий путь:
  // честному клиенту отвечаем 413 сразу, не вычитывая тело целиком в никуда.
  // Настоящий предел держит цикл ниже.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) return fail('payload_too_large')

  const chunks = []
  let size = 0

  try {
    for await (const chunk of req) {
      size += chunk.length
      // Выходим ДО push: иначе кусок, который уже превысил лимит, всё равно
      // оседает в памяти. Выход из цикла закрывает асинхронный итератор,
      // то есть чтение сокета прекращается и остаток тела не принимается.
      if (size > limit) return fail('payload_too_large')
      chunks.push(chunk)
    }
  } catch {
    // Клиент отвалился на середине или сокет сломался. Это не сбой сервера,
    // и падать в 500 здесь нечем — тела просто нет.
    return fail('invalid_payload')
  }

  if (!chunks.length) return fail('invalid_payload')

  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return fail('invalid_payload')

  let parsed
  try {
    parsed = JSON.parse(raw, dropProto)
  } catch {
    return fail('invalid_payload')
  }

  // Массивы и скаляры отсекаем здесь: дальше по коду ждут объект с полями,
  // и проверка «typeof === object» пропустила бы массив, у которого нет
  // ни одного нужного свойства, зато есть length.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('invalid_payload')
  }

  return { ok: true, value: parsed, error: null }
}
