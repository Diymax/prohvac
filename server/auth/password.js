// Хеширование паролей на scrypt из node:crypto.
//
// Почему не argon2 и не bcrypt: обе библиотеки — нативные аддоны, их установка
// требует node-gyp и компилятора на машине сборки. На shared-хостинге (Plesk)
// ни того, ни другого может не оказаться, а предсобранных бинарников под
// конкретную связку Node/glibc может не быть в кэше — деплой упадёт на
// npm install. scrypt входит в стандартную библиотеку Node, поэтому у сборки
// ноль зависимостей и ничего не ломается при смене минорной версии Node.
//
// Формат хранения самоописывающийся:
//   scrypt$<N>$<r>$<p>$<salt_base64>$<hash_base64>
// Параметры лежат рядом с хешем, поэтому их можно поднять на новом железе,
// не ломая старые записи: проверка идёт по параметрам из самой записи,
// а needsRehash() подсказывает, когда пересчитать хеш после успешного входа.

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'

// Текущие параметры. N — фактор стоимости (память и время), r — размер блока,
// p — параллелизм. При росте железа поднимаем N; старые хеши продолжат работать.
export const SCRYPT_N = 32768
export const SCRYPT_R = 8
export const SCRYPT_P = 1

const KEY_BYTES = 64
const SALT_BYTES = 16

// Ловушка: scrypt требует примерно 128 * N * r байт, при N=32768 и r=8 это
// ровно 32 MiB — столько же, сколько дефолтный maxmem в Node. Из-за служебного
// запаса лимит пробивается, и Node бросает ERR_CRYPTO_INVALID_SCRYPT_PARAMS
// на совершенно валидных параметрах. Поднимаем потолок до 128 MiB.
const SCRYPT_MAXMEM = 128 * 1024 * 1024

// Минимум по NIST SP 800-63B: длина важнее «обязательных спецсимволов»,
// которые пользователи обходят предсказуемыми подстановками.
export const PASSWORD_MIN = 12

// Верхняя граница нужна не для безопасности, а против DoS: scrypt прогоняет
// пароль через PBKDF2-SHA256, и мегабайтная строка в поле формы заставит
// сервер молоть её на каждой попытке входа.
export const PASSWORD_MAX = 200

// ---------------------------------------------------------------------------
// Отсев предсказуемых паролей
// ---------------------------------------------------------------------------
//
// Одной длины недостаточно. '1234567890qw' — двенадцать символов, то есть
// формально длиннее минимума, но подбирается первым же словарём: это просто
// цифровой ряд и две клавиши. Ровно так выглядят пароли, которые люди
// придумывают под требование «не короче двенадцати».
//
// Проверки ниже не претендуют на полноценный zxcvbn: он тянет за собой
// мегабайтные словари, а у проекта ноль рантайм-зависимостей и 500 МБ диска.
// Задача скромнее — отсечь то, что стоит атакующему секунду.

// Ряды клавиатуры и упорядоченные алфавиты. Пароль, набранный пальцем по ряду,
// содержит из них длинный кусок — в прямом или обратном порядке.
const SEQUENCE_SOURCES = Object.freeze([
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  // Русская раскладка: те же физические клавиши, тот же способ придумать пароль.
  'йцукенгшщзхъ',
  'фывапролджэ',
  'ячсмитьбю',
])

// Сколько подряд идущих символов ряда допускается. Четыре — это 'abcd' внутри
// осмысленной фразы, случайность вполне вероятная. Пять — уже не случайность.
export const SEQUENCE_MAX = 4

// Сколько раз подряд может повторяться один символ. 'aaaa' не добавляет
// стойкости, но раздувает длину до формально допустимой.
export const REPEAT_MAX = 3

/**
 * Пароли, которые стоят первыми в любом словаре для перебора. Список короткий
 * намеренно: длинные утечки — это мегабайты, а при минимуме в 12 символов
 * почти весь топ отсекается длиной. Здесь только то, что до двенадцати
 * дотягивает — само или дописанными цифрами.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'passwords',
  'qwerty', 'qwertyuiop', 'qwertyui', 'qazwsx', 'qazwsxedc', 'zaq12wsx',
  'iloveyou', 'princess', 'sunshine', 'football', 'baseball', 'superman',
  'batman', 'trustno1', 'welcome', 'monkey', 'dragon', 'master', 'shadow',
  'letmein', 'admin', 'administrator', 'root', 'default', 'changeme',
  'secret', 'login', 'access', 'freedom', 'whatever', 'starwars',
  'computer', 'internet', 'samsung', 'google', 'facebook', 'michael',
  'jennifer', 'jordan', 'hunter', 'ranger', 'soccer', 'charlie',
  'thomas', 'robert', 'daniel', 'andrew', 'matthew', 'joshua',
  'liverpool', 'chelsea', 'arsenal', 'barcelona', 'juventus',
  'parol', 'privet', 'ljhjdmt', 'пароль', 'привет', 'йцукен',
  'prohvac', 'prohvacuz', 'hvac', 'tashkent', 'uzbekistan',
])

// Обвес вокруг словарного корня: цифры и знаки, которыми пароль дотягивают
// до нужной длины ('password1234!', '2024welcome').
const TRIM_AFFIX = /^[\d\W_]+|[\d\W_]+$/gu

/** Есть ли в тексте кусок ряда клавиатуры длиннее допустимого. */
const hasSequence = (text) => {
  const window = SEQUENCE_MAX + 1

  for (const source of SEQUENCE_SOURCES) {
    const reversed = [...source].reverse().join('')
    for (let i = 0; i + window <= source.length; i += 1) {
      if (text.includes(source.slice(i, i + window))) return true
      if (text.includes(reversed.slice(i, i + window))) return true
    }
  }
  return false
}

/** Есть ли повтор одного символа длиннее допустимого. */
const hasRepeat = (text) => new RegExp(`(.)\\1{${REPEAT_MAX},}`, 'u').test(text)

/**
 * Словарный ли пароль. Сравнивается не только целиком: 'password1234' — это
 * тот же 'password', просто с приписанными цифрами, и отличается он от него
 * ровно ничем.
 */
const isCommon = (text) => {
  // Разделители внутри слова ничего не добавляют: 'prohvac-uz-7' перебирается
  // ровно так же, как 'prohvacuz7', и словарь для перебора это учитывает.
  const squashed = text.replace(/[\W_]+/gu, '')

  for (const variant of [text, squashed]) {
    if (COMMON_PASSWORDS.has(variant)) return true
    const core = variant.replace(TRIM_AFFIX, '')
    if (core && COMMON_PASSWORDS.has(core)) return true
  }

  // Длинный словарный корень внутри пароля ('myqwertyuiop') тоже не считается
  // находкой: перебор идёт по словарю с приставками и окончаниями. Короткие
  // корни не проверяем — 'admin' встречается внутри нормальных слов.
  for (const common of COMMON_PASSWORDS) {
    if (common.length >= 8 && (text.includes(common) || squashed.includes(common))) return true
  }
  return false
}

// Классы символов. Требуются три: строчная буква, заглавная и цифра.
// Спецсимвол намеренно НЕ обязателен — требование к нему люди обходят
// предсказуемым восклицательным знаком в конце, и стойкости оно не добавляет.
// Классы юникодные: пароль на кириллице ничем не хуже латинского.
const HAS_LOWER = /\p{Ll}/u
const HAS_UPPER = /\p{Lu}/u
const HAS_DIGIT = /\p{Nd}/u

/**
 * Заранее посчитанный хеш от случайной строки, пароль от которой неизвестен
 * никому. Используется при входе НЕСУЩЕСТВУЮЩЕГО пользователя: вместо раннего
 * выхода сверяем введённый пароль с этой пустышкой. Иначе ответ по отсутствующему
 * логину приходит мгновенно, а по существующему — через ~100 мс scrypt, и по
 * этой разнице перебором собирается список действующих логинов.
 */
export const DECOY_HASH =
  'scrypt$32768$8$1$DPhx5MIkOu/0Y9C+oPeVsQ==$' +
  'zJyzd2bpQq1rexJS/Quxv+x3rLojS7S3eIBdhZxA++B0OgnIELHrmGYvXFDVck/YqWuh7P8DZ8eTFz01pr/4jg=='

/**
 * Нормализация Unicode: один и тот же символ (например, «й» или буква с умляутом)
 * набирается на разных платформах разными последовательностями кодпоинтов.
 * Без NFC пароль, введённый на macOS, не совпал бы с сохранённым из Windows.
 */
const normalize = (plain) => plain.normalize('NFC')

/** Промис-обёртка над асинхронным scrypt: синхронный вариант блокирует event loop
 *  на всё время вычисления, и один вход подвешивает весь процесс Passenger. */
const derive = (plain, salt, keylen, { N, r, p }) =>
  new Promise((resolve, reject) => {
    scrypt(plain, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })

/** base64 без потерь: Buffer.from молча проглатывает мусор, поэтому сверяем
 *  обратное кодирование — так битая запись из БД не притворится валидной. */
const decodeBase64 = (value) => {
  const buffer = Buffer.from(value, 'base64')
  return buffer.toString('base64') === value ? buffer : null
}

const parseInteger = (value) => (/^[1-9]\d{0,9}$/.test(value) ? Number(value) : null)

/**
 * Разбирает запись из БД. Возвращает null на любом отклонении от формата —
 * вызывающий код обязан трактовать это как «пароль не подошёл», а не как ошибку.
 */
const parseStored = (stored) => {
  if (typeof stored !== 'string') return null

  const parts = stored.split('$')
  if (parts.length !== 6) return null

  const [scheme, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (scheme !== 'scrypt') return null

  const N = parseInteger(rawN)
  const r = parseInteger(rawR)
  const p = parseInteger(rawP)
  if (!N || !r || !p) return null

  // N обязан быть степенью двойки, иначе scrypt бросит исключение.
  if ((N & (N - 1)) !== 0 || N < 2) return null

  // Подделанная или повреждённая запись с огромным N — это запрос на выделение
  // гигабайтов памяти в процессе Passenger. Отсекаем по бюджету maxmem,
  // оставляя половину под служебные буферы самого scrypt.
  if (128 * N * r > SCRYPT_MAXMEM / 2) return null

  const salt = decodeBase64(rawSalt)
  const hash = decodeBase64(rawHash)
  if (!salt || !hash) return null
  if (salt.length < 8 || salt.length > 64) return null
  if (hash.length < 32 || hash.length > 128) return null

  return { N, r, p, salt, hash }
}

/** Хеширует пароль текущими параметрами. Проверку на стойкость не делает —
 *  для этого есть validatePasswordStrength(). */
export const hashPassword = async (plain) => {
  if (typeof plain !== 'string' || !plain) {
    throw new TypeError('hashPassword: ожидается непустая строка')
  }
  if (plain.length > PASSWORD_MAX) {
    throw new RangeError('hashPassword: пароль длиннее допустимого')
  }

  const salt = randomBytes(SALT_BYTES)
  const key = await derive(normalize(plain), salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/**
 * Сверяет пароль с записью. Никогда не бросает: мусор вместо хеша — это
 * штатная ситуация (повреждённая строка в БД, чужой формат после миграции),
 * и она должна давать честный false, а не 500 на форме входа.
 */
export const verifyPassword = async (plain, stored) => {
  const parsed = parseStored(stored)
  if (!parsed) return false
  if (typeof plain !== 'string' || plain.length > PASSWORD_MAX) return false

  try {
    // Длину ключа берём из самой записи, а не из KEY_BYTES: иначе после
    // увеличения keylen перестали бы проверяться все старые пароли.
    const key = await derive(normalize(plain), parsed.salt, parsed.hash.length, parsed)
    // timingSafeEqual падает на буферах разной длины, поэтому сверяем заранее.
    if (key.length !== parsed.hash.length) return false
    return timingSafeEqual(key, parsed.hash)
  } catch {
    return false
  }
}

/**
 * Нужно ли пересчитать хеш. Вызывать после УСПЕШНОГО входа — только там есть
 * пароль в открытом виде. Битый формат тоже даёт true: такую запись всё равно
 * пора заменить.
 */
export const needsRehash = (stored) => {
  const parsed = parseStored(stored)
  if (!parsed) return true

  return (
    parsed.N < SCRYPT_N ||
    parsed.r < SCRYPT_R ||
    parsed.p < SCRYPT_P ||
    parsed.salt.length < SALT_BYTES ||
    parsed.hash.length < KEY_BYTES
  )
}

/**
 * Проверяет стойкость пароля при регистрации и смене.
 *
 * Порядок проверок — от самой понятной причины к самой частной: человек
 * увидит ровно одну ошибку и должен по ней понять, что именно чинить.
 *
 * @param {string} plain пароль в открытом виде
 * @param {string} [username] логин владельца — пароль не должен его повторять
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export const validatePasswordStrength = (plain, username) => {
  if (typeof plain !== 'string') return { ok: false, error: 'invalid_payload' }

  // Считаем кодпоинты, а не единицы UTF-16: иначе пароль из шести эмодзи
  // прошёл бы как «двенадцать символов».
  const length = Array.from(plain).length
  if (length < PASSWORD_MIN) return { ok: false, error: 'password_too_short' }
  if (length > PASSWORD_MAX) return { ok: false, error: 'password_too_long' }

  const normalized = normalize(plain)

  if (typeof username === 'string' && username.trim()) {
    // Регистр не учитываем: «Admin» вместо «admin» перебирается первой же попыткой.
    if (normalized.trim().toLowerCase() === normalize(username).trim().toLowerCase()) {
      return { ok: false, error: 'password_equals_username' }
    }
  }

  if (!HAS_LOWER.test(normalized) || !HAS_UPPER.test(normalized) || !HAS_DIGIT.test(normalized)) {
    return { ok: false, error: 'password_needs_mix' }
  }

  // Регистр для трёх проверок ниже не значим: 'QWERTYUIOP' подбирается ровно
  // так же, как 'qwertyuiop'.
  const lowered = normalized.toLowerCase()

  if (hasRepeat(lowered)) return { ok: false, error: 'password_repeat' }
  if (hasSequence(lowered)) return { ok: false, error: 'password_sequence' }
  if (isCommon(lowered)) return { ok: false, error: 'password_common' }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Генерация временного пароля
// ---------------------------------------------------------------------------

// Похожие друг на друга символы исключены: временный пароль диктуют голосом
// и переписывают с экрана, и 'l' против '1' здесь дороже пары бит энтропии.
const GENERATED_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const GENERATED_LENGTH = 24

const randomPassword = () => {
  let password = ''
  // randomInt из node:crypto, а не Math.random: последний предсказуем по
  // нескольким выборкам, и «сгенерированный» пароль восстанавливался бы
  // из соседних.
  for (let i = 0; i < GENERATED_LENGTH; i += 1) {
    password += GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)]
  }
  return password
}

/**
 * Сгенерированный пароль, заведомо проходящий validatePasswordStrength.
 *
 * Случайные 24 символа стойки сами по себе, но проверка смотрит не только
 * на энтропию: примерно один пароль из шестидесяти не содержит ни одной цифры,
 * и такой временный пароль пользователь получил бы, а сменить его на самого
 * себя не смог — форма отвергла бы его же собственным правилом.
 *
 * Перебор ограничен: при исправном алфавите хватает первой-второй попытки,
 * а бесконечный цикл на несовместимых правилах должен падать, а не висеть.
 *
 * @param {string} [username] логин будущего владельца пароля, если он известен
 * @returns {string}
 */
export const generatePassword = (username) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const password = randomPassword()
    if (validatePasswordStrength(password, username).ok) return password
  }
  throw new Error(
    'не удалось сгенерировать пароль, проходящий проверку стойкости — ' +
    'проверьте GENERATED_ALPHABET и validatePasswordStrength'
  )
}
