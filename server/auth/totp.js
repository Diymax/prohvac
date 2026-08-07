// TOTP (RFC 6238) поверх HOTP (RFC 4226) на одном node:crypto.
// Второй фактор для входа в админку: приложение-аутентификатор на телефоне
// (Google Authenticator, Aegis, 1Password) считает код из общего секрета
// и текущего времени, сервер считает его же и сравнивает.
//
// Состояния здесь нет намеренно: на Passenger крутится пул процессов, поэтому
// последний использованный шаг (lastUsedStep) хранит вызывающий код в SQLite
// и передаёт его в verifyTotp параметром.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { decode, encode } from './base32.js'

export const DEFAULT_ISSUER = 'PROHVAC'
export const DEFAULT_DIGITS = 6
export const DEFAULT_PERIOD = 30
export const DEFAULT_ALGORITHM = 'SHA1'

// RFC 4226 §4 R6: секрет не короче 128 бит, рекомендованная длина — 160.
const SECRET_BYTES = 20

const HMAC_ALGORITHMS = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' }

// Алфавит Крокфорда: цифры плюс буквы без I, L, O и U. Первые три не путаются
// с 1 и 0 при чтении с бумаги, U выброшена, чтобы случайный код не сложился
// в непристойное слово. 10 символов по 5 бит = 50 бит энтропии на код.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_GROUP = 5

const normalizeAlgorithm = (algorithm) => {
  const name = String(algorithm).toUpperCase()
  if (!HMAC_ALGORITHMS[name]) throw new Error(`totp: неподдерживаемый алгоритм ${algorithm}`)
  return name
}

const hmacName = (algorithm) => HMAC_ALGORITHMS[normalizeAlgorithm(algorithm)]

// Больше 8 цифр не даёт динамическая усечка (31 бит < 10^10), меньше 6
// запрещает RFC 4226 §5.3.
const checkDigits = (digits) => {
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error(`totp: digits должен быть 6..8, получено ${digits}`)
  }
  return digits
}

const checkPeriod = (period) => {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`totp: period должен быть целым > 0, получено ${period}`)
  }
  return period
}

/** Секрет принимаем и байтами, и base32-строкой из базы. */
const toSecretBuffer = (secret) => {
  const buf = Buffer.isBuffer(secret) ? secret : decode(secret)
  if (buf.length === 0) throw new Error('totp: пустой секрет')
  return buf
}

/** Номер временного шага T по RFC 6238 (T0 = 0). */
const stepAt = (timeMs, period) => Math.floor(timeMs / 1000 / period)

/** Новый секрет: 160 случайных бит в base32. */
export const generateSecret = () => encode(randomBytes(SECRET_BYTES))

/**
 * Ссылка otpauth:// для QR-кода и ручного добавления в приложение.
 * @param {{secret: string, account: string, issuer?: string, digits?: number,
 *          period?: number, algorithm?: string}} params
 * @returns {string}
 */
export const buildOtpauthUri = ({
  secret,
  account,
  issuer = DEFAULT_ISSUER,
  digits = DEFAULT_DIGITS,
  period = DEFAULT_PERIOD,
  algorithm = DEFAULT_ALGORITHM,
} = {}) => {
  if (typeof secret !== 'string' || !secret) throw new Error('totp: secret обязателен')
  if (typeof account !== 'string' || !account) throw new Error('totp: account обязателен')
  if (typeof issuer !== 'string' || !issuer) throw new Error('totp: issuer обязателен')

  const algo = normalizeAlgorithm(algorithm)
  checkDigits(digits)
  checkPeriod(period)

  // issuer намеренно дублируется: в префиксе label и в query-параметре.
  // Старые версии Google Authenticator читают только префикс label, ветка
  // с параметром issuer появилась позже; если оставить что-то одно, часть
  // приложений показывает запись без названия сервиса, а часть при повторном
  // сканировании заводит её дублем вместо обновления существующей.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`

  const query = [
    `secret=${encodeURIComponent(secret)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    `algorithm=${algo}`,
    `digits=${digits}`,
    `period=${period}`,
  ].join('&')

  return `otpauth://totp/${label}?${query}`
}

/**
 * HOTP по RFC 4226: HMAC от 8-байтного счётчика с динамической усечкой.
 * @param {Buffer|string} secretBuf
 * @param {number|bigint} counter
 * @param {number} [digits]
 * @param {string} [algorithm]
 * @returns {string}
 */
export const hotp = (secretBuf, counter, digits = DEFAULT_DIGITS, algorithm = DEFAULT_ALGORITHM) => {
  const secret = toSecretBuffer(secretBuf)
  const size = checkDigits(digits)

  // Счётчик пишем через BigInt, а не парой writeUInt32BE: при малом period
  // и датах из тестовых векторов RFC (T = 20000000000) номер шага
  // не помещается в 32 бита.
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigUInt64BE(BigInt(counter))

  const digest = createHmac(hmacName(algorithm), secret).update(counterBuf).digest()

  // Динамическая усечка, RFC 4226 §5.3: младший полубайт последнего байта
  // задаёт смещение, оттуда берём 31 бит (старший обнуляем, чтобы результат
  // не зависел от трактовки знакового бита).
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]

  return String(binary % 10 ** size).padStart(size, '0')
}

/**
 * Код для момента времени.
 * @param {Buffer|string} secret
 * @param {{timeMs?: number, period?: number, digits?: number, algorithm?: string}} [options]
 * @returns {string}
 */
export const totpCode = (secret, options = {}) => {
  const {
    timeMs = Date.now(),
    period = DEFAULT_PERIOD,
    digits = DEFAULT_DIGITS,
    algorithm = DEFAULT_ALGORITHM,
  } = options

  return hotp(toSecretBuffer(secret), stepAt(timeMs, checkPeriod(period)), digits, algorithm)
}

/**
 * Проверяет код. Возвращает { ok: true, matchedStep } либо { ok: false, reason }.
 *
 * matchedStep вызывающий код обязан сохранить и передать следующим вызовом
 * как lastUsedStep: иначе один и тот же код принимается повторно, пока
 * не истечёт окно (RFC 6238 §5.2).
 *
 * @param {Buffer|string} secret
 * @param {string} code
 * @param {{timeMs?: number, period?: number, digits?: number, algorithm?: string,
 *          window?: number, lastUsedStep?: number|null}} [options]
 */
export const verifyTotp = (secret, code, options = {}) => {
  const {
    timeMs = Date.now(),
    period = DEFAULT_PERIOD,
    digits = DEFAULT_DIGITS,
    algorithm = DEFAULT_ALGORITHM,
    // ±1 шаг по RFC 6238 §5.2: компенсирует расхождение часов телефона
    // и сервера и время, пока пользователь набирает код.
    window = 1,
    lastUsedStep = null,
  } = options

  const size = checkDigits(digits)
  if (!Number.isInteger(window) || window < 0) {
    throw new Error(`totp: window должен быть целым >= 0, получено ${window}`)
  }

  // Приложения показывают код группами («123 456»), пользователи копируют
  // их вместе с разделителем.
  const cleanCode = String(code ?? '').replace(/[\s-]+/g, '')
  if (cleanCode.length !== size || !/^\d+$/.test(cleanCode)) {
    return { ok: false, reason: 'malformed' }
  }

  const secretBuf = toSecretBuffer(secret)
  const currentStep = stepAt(timeMs, checkPeriod(period))
  const given = Buffer.from(cleanCode, 'utf8')

  let matchedStep = null
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset
    if (step < 0) continue

    const expected = Buffer.from(hotp(secretBuf, step, size, algorithm), 'utf8')
    // Проход по всему окну без break и timingSafeEqual вместо '===':
    // и ранний выход, и посимвольное сравнение делают время ответа зависимым
    // от того, насколько угаданный код близок к настоящему.
    const equal = timingSafeEqual(given, expected)
    if (equal && matchedStep === null) matchedStep = step
  }

  if (matchedStep === null) return { ok: false, reason: 'invalid' }

  // Код живёт несколько шагов, поэтому подсмотренный или перехваченный код
  // можно предъявить второй раз. Принимаем только шаг строго новее принятого.
  if (lastUsedStep != null && matchedStep <= lastUsedStep) {
    return { ok: false, reason: 'reused' }
  }

  return { ok: true, matchedStep }
}

/**
 * Резервные коды на случай потери телефона: формат 'XXXXX-XXXXX'.
 * @param {number} [n]
 * @returns {string[]}
 */
export const generateRecoveryCodes = (n = 10) => {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`totp: количество кодов должно быть целым > 0, получено ${n}`)
  }

  const length = RECOVERY_GROUP * 2
  const codes = new Set()

  // Через Set, а не map: совпадение двух кодов маловероятно, но погашение
  // одного кода при коллизии гасило бы сразу два.
  while (codes.size < n) {
    const bytes = randomBytes(length)
    let code = ''
    for (let i = 0; i < length; i += 1) {
      // 256 делится на 32 нацело, поэтому остаток не перекашивает
      // распределение и вычитать смещение не нужно.
      code += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length]
      if (i === RECOVERY_GROUP - 1) code += '-'
    }
    codes.add(code)
  }

  return [...codes]
}
