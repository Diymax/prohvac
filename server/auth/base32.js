// Кодек base32 по RFC 4648, без padding.
//
// Нужен, потому что в этом виде TOTP-секрет попадает в otpauth-ссылку, в QR-код
// и в поле ручного ввода Google Authenticator. node:crypto base32 не умеет
// (Buffer знает только hex/base64), а тянуть npm-пакет ради сорока строк
// в проект с нулём рантайм-зависимостей нельзя.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

// Обратную таблицу строим один раз при загрузке модуля: decode вызывается
// на каждой проверке кода, а ALPHABET.indexOf(ch) — линейный поиск.
const LOOKUP = new Map()
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP.set(ALPHABET[i], i)

/**
 * Кодирует байты в base32-строку без символов '='.
 * @param {Buffer|Uint8Array} input
 * @returns {string}
 */
export const encode = (input) => {
  if (!Buffer.isBuffer(input) && !ArrayBuffer.isView(input)) {
    throw new TypeError('base32.encode: ожидался Buffer')
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)

  let out = ''
  let acc = 0
  let bits = 0

  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(acc >>> bits) & 31]
    }
  }

  // Хвост короче 5 бит добиваем нулями справа. Padding '=' не пишем: в otpauth
  // он не используется, а часть приложений на нём спотыкается при ручном вводе.
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]

  return out
}

/**
 * Декодирует base32-строку в байты. Регистр не важен; пробелы и дефисы
 * игнорируются — ими секрет разбивают на группы при показе пользователю,
 * и он копирует строку вместе с ними. Хвостовые '=' допускаем ради секретов
 * из чужих генераторов, которые padding всё-таки пишут.
 * @param {string} input
 * @returns {Buffer}
 */
export const decode = (input) => {
  if (typeof input !== 'string') throw new TypeError('base32.decode: ожидалась строка')

  const clean = input.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()

  const bytes = []
  let acc = 0
  let bits = 0

  for (const ch of clean) {
    const value = LOOKUP.get(ch)
    if (value === undefined) {
      throw new Error(`base32.decode: недопустимый символ ${JSON.stringify(ch)}`)
    }
    acc = (acc << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >>> bits) & 0xff)
    }
  }

  // Остаток в 5 и более бит — это лишний символ, не давший ни одного байта.
  // Такой длины у корректного base32 быть не может (n % 8 ∈ {1, 3, 6}).
  if (bits >= 5) throw new Error('base32.decode: некорректная длина строки')

  // Биты добивки обязаны быть нулевыми, иначе один и тот же секрет имеет
  // несколько допустимых записей — а секрет мы сравниваем и как строку тоже.
  if ((acc & ((1 << bits) - 1)) !== 0) {
    throw new Error('base32.decode: ненулевые биты в хвосте')
  }

  return Buffer.from(bytes)
}
