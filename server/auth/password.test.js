import { randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DECOY_HASH,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SCRYPT_N,
  hashPassword,
  needsRehash,
  validatePasswordStrength,
  verifyPassword,
} from './password.js'

const PASSWORD = 'Sovsem-Ne-Parol-2026'

// Тот же потолок памяти, что и в модуле: при N=32768 дефолтных 32 MiB
// не хватает и scryptSync падает с ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const MAXMEM = 128 * 1024 * 1024

/** Хеш со СТАРЫМИ параметрами: проверяем, что самоописывающийся формат
 *  позволяет читать записи, созданные до подъёма N. */
const legacyHash = (plain, { N = 16384, r = 8, p = 1, keylen = 64, saltBytes = 16 } = {}) => {
  const salt = randomBytes(saltBytes)
  const key = scryptSync(plain, salt, keylen, { N, r, p, maxmem: MAXMEM })
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
}

describe('hashPassword', () => {
  it('возвращает запись в самоописывающемся формате', async () => {
    const stored = await hashPassword(PASSWORD)
    const [scheme, n, r, p, salt, hash] = stored.split('$')

    expect(scheme).toBe('scrypt')
    expect(Number(n)).toBe(SCRYPT_N)
    expect(Number(r)).toBe(8)
    expect(Number(p)).toBe(1)
    expect(Buffer.from(salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(hash, 'base64')).toHaveLength(64)
  })

  it('даёт разные хеши для одного пароля — соль случайная', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)])
    expect(a).not.toBe(b)
  })

  it('отказывается хешировать не-строку и слишком длинный пароль', async () => {
    await expect(hashPassword(null)).rejects.toThrow(TypeError)
    await expect(hashPassword('')).rejects.toThrow(TypeError)
    await expect(hashPassword('a'.repeat(PASSWORD_MAX + 1))).rejects.toThrow(RangeError)
  })
})

describe('verifyPassword', () => {
  it('раунд-трип: свой пароль подходит', async () => {
    const stored = await hashPassword(PASSWORD)
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true)
  })

  it('отвергает неверный пароль, в том числе отличающийся регистром', async () => {
    const stored = await hashPassword(PASSWORD)
    await expect(verifyPassword(`${PASSWORD}x`, stored)).resolves.toBe(false)
    await expect(verifyPassword(PASSWORD.toLowerCase(), stored)).resolves.toBe(false)
    await expect(verifyPassword('', stored)).resolves.toBe(false)
  })

  it('читает хеш со старыми параметрами', async () => {
    const stored = legacyHash(PASSWORD)
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true)
    await expect(verifyPassword('другой пароль!!', stored)).resolves.toBe(false)
  })

  it('совпадает при разной нормализации Unicode', async () => {
    // «é» составным символом (e + U+0301) и одним кодпоинтом U+00E9.
    const composed = 'Пароль-é-длинный'
    const stored = await hashPassword(composed)
    await expect(verifyPassword(composed.normalize('NFC'), stored)).resolves.toBe(true)
  })

  it('возвращает false, а не исключение, на мусоре вместо хеша', async () => {
    const garbage = [
      '',
      'null',
      'не хеш вовсе',
      '$$$$$',
      'scrypt$32768$8$1$onlyfiveparts',
      'scrypt$32768$8$1$AAAA$AAAA$AAAA',
      'bcrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA',
      // N не степень двойки — scrypt бросил бы ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
      'scrypt$32767$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA',
      // N за пределами бюджета maxmem: попытка выделить гигабайты.
      'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA',
      'scrypt$0$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA',
      'scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA',
      // Соль и хеш — не base64.
      'scrypt$32768$8$1$!!!!$????',
      // Хеш обрезан до 2 байт.
      'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAA=',
      null,
      undefined,
      42,
      {},
      [],
    ]

    for (const stored of garbage) {
      await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false)
    }
  })

  it('возвращает false на нестроковом пароле и на слишком длинном', async () => {
    const stored = await hashPassword(PASSWORD)
    await expect(verifyPassword(null, stored)).resolves.toBe(false)
    await expect(verifyPassword(12345678901234, stored)).resolves.toBe(false)
    await expect(verifyPassword('a'.repeat(PASSWORD_MAX + 1), stored)).resolves.toBe(false)
  })
})

describe('DECOY_HASH', () => {
  it('это валидная запись с текущими параметрами', () => {
    expect(needsRehash(DECOY_HASH)).toBe(false)
  })

  it('не подходит ни к какому паролю', async () => {
    await expect(verifyPassword(PASSWORD, DECOY_HASH)).resolves.toBe(false)
    await expect(verifyPassword('', DECOY_HASH)).resolves.toBe(false)
  })
})

describe('needsRehash', () => {
  it('свежий хеш пересчитывать не нужно', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false)
  })

  it('требует пересчёта при параметрах ниже текущих', () => {
    expect(needsRehash(legacyHash(PASSWORD))).toBe(true)
    expect(needsRehash(legacyHash(PASSWORD, { N: SCRYPT_N, r: 4 }))).toBe(true)
    // Короткий ключ (32 байта вместо 64) тоже повод пересчитать.
    expect(needsRehash(legacyHash(PASSWORD, { N: SCRYPT_N, keylen: 32 }))).toBe(true)
  })

  it('требует пересчёта при короткой соли', () => {
    expect(needsRehash(legacyHash(PASSWORD, { N: SCRYPT_N, saltBytes: 8 }))).toBe(true)
  })

  it('требует пересчёта на битой записи', () => {
    expect(needsRehash('мусор')).toBe(true)
    expect(needsRehash('')).toBe(true)
    expect(needsRehash(null)).toBe(true)
    expect(needsRehash(undefined)).toBe(true)
  })
})

describe('validatePasswordStrength', () => {
  it('принимает пароль, удовлетворяющий всем правилам', () => {
    expect(validatePasswordStrength(PASSWORD, 'admin')).toEqual({ ok: true })
    expect(validatePasswordStrength('Xolodilnik-Vozduh-7', 'admin')).toEqual({ ok: true })
    // Кириллица не хуже латиницы: классы символов проверяются юникодными
    // свойствами, а не диапазоном ASCII.
    expect(validatePasswordStrength('Морозный-Ветер-9', 'admin')).toEqual({ ok: true })
  })

  it('отвергает слишком короткий', () => {
    const result = validatePasswordStrength('Ab1cdefghij'.slice(0, PASSWORD_MIN - 1), 'admin')
    expect(result).toEqual({ ok: false, error: 'password_too_short' })
  })

  it('считает символы, а не единицы UTF-16', () => {
    // Эмодзи разные: четыре одинаковых подряд отвергаются отдельным правилом,
    // а здесь проверяется ровно подсчёт длины. Каждое эмодзи — две единицы
    // UTF-16 и один символ.
    const emoji = [...'🙂🙃😀😃😄😁😆😅😂']
    const short = `Ab1${emoji.slice(0, 8).join('')}`
    const long = `Ab1${emoji.slice(0, 9).join('')}`

    expect(Array.from(short)).toHaveLength(PASSWORD_MIN - 1)
    expect(validatePasswordStrength(short, 'admin').error).toBe('password_too_short')
    expect(validatePasswordStrength(long, 'admin').ok).toBe(true)
  })

  it('отвергает слишком длинный', () => {
    expect(validatePasswordStrength('a'.repeat(PASSWORD_MAX + 1), 'admin').error).toBe(
      'password_too_long'
    )
  })

  it('запрещает пароль, совпадающий с логином, без учёта регистра и пробелов', () => {
    expect(validatePasswordStrength('administrator', 'administrator').error).toBe(
      'password_equals_username'
    )
    expect(validatePasswordStrength('Administrator', ' ADMINISTRATOR ').error).toBe(
      'password_equals_username'
    )
  })

  it('требует строчную букву, заглавную и цифру', () => {
    expect(validatePasswordStrength('vozduhovodnik', 'admin').error).toBe('password_needs_mix')
    expect(validatePasswordStrength('VOZDUHOVODNIK7', 'admin').error).toBe('password_needs_mix')
    expect(validatePasswordStrength('Vozduhovodnik', 'admin').error).toBe('password_needs_mix')
    expect(validatePasswordStrength('Vozduhovodnik7', 'admin').ok).toBe(true)
  })

  it('отвергает четыре и более одинаковых символа подряд', () => {
    expect(validatePasswordStrength('Vozduh7aaaa-Ok', 'admin').error).toBe('password_repeat')
    // Три подряд — ещё не признак: так пишутся настоящие слова.
    expect(validatePasswordStrength('Vozduh7aaa-Okno', 'admin').ok).toBe(true)
  })

  it('отвергает ряды клавиатуры и алфавита', () => {
    // Именно тот случай, ради которого правило и заведено: двенадцать символов,
    // формально длина есть, а перебирается словарём мгновенно.
    expect(validatePasswordStrength('1234567890qwA', 'admin').error).toBe('password_sequence')
    expect(validatePasswordStrength('Qwerty12345Ab', 'admin').error).toBe('password_sequence')
    expect(validatePasswordStrength('Asdfgh7-Vozduh', 'admin').error).toBe('password_sequence')
    // Обратный порядок ничем не лучше прямого.
    expect(validatePasswordStrength('Ok7-poiuytrewq', 'admin').error).toBe('password_sequence')
    // Русская раскладка — те же физические клавиши.
    expect(validatePasswordStrength('Йцукен7-Ветер', 'admin').error).toBe('password_sequence')
    // Четыре подряд допустимы: 'abcd' встречается внутри осмысленных строк.
    expect(validatePasswordStrength('Vozduh7-abcd-Ok', 'admin').ok).toBe(true)
  })

  it('отвергает словарные пароли и их варианты с цифрами', () => {
    expect(validatePasswordStrength('Password1234', 'admin').error).toBe('password_common')
    expect(validatePasswordStrength('2024-Welcome!', 'admin').error).toBe('password_common')
    expect(validatePasswordStrength('MyIloveyou77', 'admin').error).toBe('password_common')
    expect(validatePasswordStrength('Prohvac-Uz-7', 'admin').error).toBe('password_common')
  })

  it('не падает без логина и на нестроковом пароле', () => {
    expect(validatePasswordStrength(PASSWORD).ok).toBe(true)
    expect(validatePasswordStrength(PASSWORD, null).ok).toBe(true)
    expect(validatePasswordStrength(null, 'admin').error).toBe('invalid_payload')
    expect(validatePasswordStrength(undefined, 'admin').error).toBe('invalid_payload')
    expect(validatePasswordStrength(12345678901234, 'admin').error).toBe('invalid_payload')
  })
})
