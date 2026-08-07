// Шифрование секретов, которые обязаны лежать в базе: токен Telegram-бота,
// секреты TOTP, ключ DeepL.
//
// ПОЧЕМУ ЭТО ВООБЩЕ ШИФРУЕТСЯ.
// app.sqlite — обычный файл. Он целиком уезжает в автобэкап Plesk, в архив,
// который скачивают «посмотреть заявки», и в копию базы на ноутбуке
// разработчика. Дамп расходится по местам, которые мы не контролируем,
// и его утечка не должна означать утечку боевого токена бота: с этим токеном
// отправляют сообщения от имени компании и вычитывают весь чат отдела продаж.
// Ключ выводится из APP_SECRET (переменная окружения в панели хостинга)
// и в базе не хранится — дамп без окружения бесполезен.
//
// AES-256-GCM, а не CBC или CTR: GCM аутентифицирует шифротекст. Подменённая
// или побитая строка даёт честную ошибку расшифровки, а не тихо превращается
// в мусор, который уедет в заголовок Authorization запроса к Bot API.
//
// Ключ на каждое назначение (purpose) свой: HKDF-SHA256(APP_SECRET, соль,
// purpose). При едином ключе шифротекст TOTP-секрета можно было бы переставить
// в колонку токена бота — криптографически такая запись корректна, и GCM
// подмены не заметил бы. Разные ключи плюс purpose в AAD делают перестановку
// неотличимой от порчи данных.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { config } from '../config.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
// Длины ниже зафиксированы и в схеме БД (CHECK на *_iv и *_tag), менять их
// без миграции нельзя. 12 байт — штатный размер nonce для GCM (NIST SP 800-38D
// §5.2.1.1), при другой длине реализация делает лишний GHASH над nonce.
const IV_BYTES = 12
const TAG_BYTES = 16

// Потолок на открытый текст. Секреты здесь — это токены и ключи в десятки
// символов; всё, что длиннее килобайтов, означает, что в seal() по ошибке
// поехал файл или JSON целиком, и такое лучше поймать сразу.
const SECRET_MAX = 4096

// Соль HKDF не секретная (RFC 5869 §3.1) и намеренно захардкожена: её задача —
// привязать вывод ключей к этому приложению и к версии формата. Понадобится
// сменить схему шифрования — появится v2, и новый ключ не совпадёт со старым.
const HKDF_SALT = Buffer.from('prohvac/secretbox/v1')
const INFO_PREFIX = 'prohvac/v1/'

// Метка назначения: строчные латинские буквы, цифры и дефис, 3..32 символа.
// Ограничение не косметическое — purpose участвует в выводе ключа и в AAD,
// поэтому 'totp-secret' и 'TOTP-Secret' дали бы разные ключи, а вскрылось бы
// это только при попытке расшифровать чужую запись.
const PURPOSE_PATTERN = /^[a-z][a-z0-9-]{2,31}$/

/**
 * Известные назначения. Импортировать их, а не писать строку по месту:
 * опечатка в purpose при записи не проявляется вообще никак, а при чтении
 * выглядит как повреждённая база.
 */
export const PURPOSE = Object.freeze({
  telegramToken: 'telegram-token',
  totpSecret: 'totp-secret',
  deeplKey: 'deepl-key',
})

// Кэш выведенных ключей на процесс: hkdfSync дешёвый, но deriveKey зовётся
// и из hashid.js на каждом запросе. Секретности не убавляет — ключ всё равно
// живёт в памяти процесса ровно столько же.
const keyCache = new Map()

const assertPurpose = (purpose) => {
  if (typeof purpose !== 'string' || !PURPOSE_PATTERN.test(purpose)) {
    throw new TypeError(
      `secretbox: purpose должен подходить под ${PURPOSE_PATTERN}, получено "${purpose}"`
    )
  }
  return purpose
}

const infoFor = (purpose) => `${INFO_PREFIX}${purpose}`

/**
 * Подключ для назначения. Экспортируется, потому что HMAC-хеши в hashid.js
 * должны разделяться с шифрованием ровно так же: один APP_SECRET, разные ключи.
 *
 * @param {string} purpose метка назначения из PURPOSE или своя
 * @param {number} [length] длина ключа в байтах
 * @returns {Buffer}
 */
export const deriveKey = (purpose, length = KEY_BYTES) => {
  assertPurpose(purpose)

  const cacheKey = `${purpose}/${length}`
  const cached = keyCache.get(cacheKey)
  if (cached) return cached

  // Пустой APP_SECRET означает ключ, выведенный из пустой строки, то есть
  // одинаковый у всех, кто прочитал этот исходник. Боевой старт такое не
  // пропустит (assertProductionConfig), но утилиты и cron конфиг не зовут.
  if (!config.appSecret) {
    throw new Error('secretbox: APP_SECRET пуст — выводить ключ шифрования не из чего')
  }

  const key = Buffer.from(hkdfSync('sha256', config.appSecret, HKDF_SALT, infoFor(purpose), length))
  keyCache.set(cacheKey, key)
  return key
}

/**
 * node:sqlite отдаёт BLOB как Uint8Array, а не Buffer, и createDecipheriv
 * на нём работает, но length/compare ведут себя иначе. Приводим один раз
 * на входе, чтобы дальше в модуле был только Buffer.
 */
const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

/**
 * Шифрует секрет. Возвращает три части ровно в том виде, в каком они лежат
 * в БД отдельными BLOB-колонками (*_ct, *_iv, *_tag).
 *
 * @param {string} plaintext
 * @param {string} purpose
 * @returns {{ct: Buffer, iv: Buffer, tag: Buffer}}
 */
export const seal = (plaintext, purpose) => {
  assertPurpose(purpose)

  if (typeof plaintext !== 'string') {
    throw new TypeError('secretbox: plaintext должен быть строкой')
  }
  // Пустая строка как секрет — это всегда баг вызывающего кода: «значение
  // не задано» выражается отсутствием строки в таблице, а не шифротекстом
  // от пустоты, который потом невозможно отличить от настоящего секрета.
  if (!plaintext) {
    throw new RangeError('secretbox: пустой секрет не шифруется — храните отсутствие как NULL')
  }
  if (plaintext.length > SECRET_MAX) {
    throw new RangeError(`secretbox: секрет длиннее ${SECRET_MAX} символов`)
  }

  // Случайный nonce на каждую запись. Повтор пары (ключ, nonce) в GCM ломает
  // не только конкретную запись, а вскрывает ключ аутентификации целиком,
  // поэтому nonce берётся из CSPRNG и никогда не считается счётчиком: под
  // Passenger процессов несколько, общего счётчика у них нет. При 96 битах
  // и сотнях записей за всё время жизни базы вероятность коллизии ничтожна.
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, deriveKey(purpose), iv)
  cipher.setAAD(Buffer.from(infoFor(purpose)))

  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ct, iv, tag: cipher.getAuthTag() }
}

/**
 * Расшифровывает и проверяет подлинность. Бросает при любой порче: битый тег,
 * подменённый шифротекст, чужой purpose, обрезанный nonce.
 *
 * Именно бросает, а не возвращает null: неудачная аутентификация означает,
 * что база или ключ не те, за кого себя выдают. Тихий null превратился бы
 * в «токен бота не задан» и в молча не отправленные заявки.
 *
 * @param {{ct: Buffer|Uint8Array, iv: Buffer|Uint8Array, tag: Buffer|Uint8Array}} box
 * @param {string} purpose тот же, что и при seal()
 * @returns {string}
 */
export const open = (box, purpose) => {
  assertPurpose(purpose)

  if (!box || typeof box !== 'object') {
    throw new TypeError('secretbox: ожидается объект {ct, iv, tag}')
  }

  const ct = toBuffer(box.ct)
  const iv = toBuffer(box.iv)
  const tag = toBuffer(box.tag)

  if (!ct || !iv || !tag) {
    throw new TypeError('secretbox: ct, iv и tag должны быть Buffer или Uint8Array')
  }
  // Длины проверяем до расшифровки: setAuthTag на теге неверной длины бросает
  // ERR_CRYPTO_INVALID_AUTH_TAG, и по такому сообщению непонятно, что именно
  // в базе испорчено.
  if (iv.length !== IV_BYTES) {
    throw new RangeError(`secretbox: iv должен быть ${IV_BYTES} байт, получено ${iv.length}`)
  }
  if (tag.length !== TAG_BYTES) {
    throw new RangeError(`secretbox: tag должен быть ${TAG_BYTES} байт, получено ${tag.length}`)
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(purpose), iv)
    decipher.setAAD(Buffer.from(infoFor(purpose)))
    decipher.setAuthTag(tag)
    // final() и есть проверка тега: до неё update() отдаёт данные, которым
    // ещё нельзя доверять, поэтому наружу отдаём только собранный результат.
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch (error) {
    // Оригинальное сообщение OpenSSL ('Unsupported state or unable to
    // authenticate data') в логе админки не говорит ничего. Причину кладём
    // в cause, наружу — внятный текст.
    throw new Error(
      `secretbox: не удалось расшифровать значение purpose="${purpose}" — ` +
        'запись повреждена либо APP_SECRET сменился',
      { cause: error }
    )
  }
}

const PREVIEW_MASK = '****'
const PREVIEW_TAIL = 4
// Хвост показываем, только если он заметно короче самого секрета: у ключа
// в 12 символов четыре открытых — это уже треть, и подбор становится реальным.
const PREVIEW_MIN_BODY = 12
// Осмысленный префикс схемы ('dpl_', 'sk-', 'xoxb-'). Он не секрет, а маркер
// провайдера, и именно по нему в интерфейсе видно, что вставили не тот ключ.
// Начинается с буквы намеренно: у токена Telegram впереди id бота, показывать
// его не надо — это половина токена.
const PREVIEW_PREFIX = /^([a-z][a-z0-9]{0,11}[_:-])/i

/**
 * Безопасная маска для интерфейса: 'dpl_****4f2a'. Кладётся в settings.preview
 * рядом с шифротекстом, чтобы админ видел, что ключ задан и какой именно,
 * не запрашивая расшифровку.
 *
 * @param {string} plaintext
 * @returns {string} пустая строка, если показывать нечего
 */
export const preview = (plaintext) => {
  const text = typeof plaintext === 'string' ? plaintext.trim() : ''
  if (!text) return ''

  const prefix = PREVIEW_PREFIX.exec(text)?.[1] ?? ''
  const body = text.slice(prefix.length)

  if (body.length < PREVIEW_MIN_BODY) return `${prefix}${PREVIEW_MASK}`
  return `${prefix}${PREVIEW_MASK}${body.slice(-PREVIEW_TAIL)}`
}
