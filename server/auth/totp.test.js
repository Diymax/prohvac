import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decode, encode } from './base32.js'
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateSecret,
  hotp,
  totpCode,
  verifyTotp,
} from './totp.js'

// Секрет из тестовых векторов RFC 4226 и RFC 6238: ASCII '12345678901234567890'.
const RFC_SECRET_ASCII = '12345678901234567890'
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const RFC_SECRET = Buffer.from(RFC_SECRET_ASCII, 'ascii')

// Секреты SHA-векторов RFC 6238 получены повторением того же seed до нужной
// длины ключа — так они заданы в Appendix B.
const RFC_SECRET_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii')
const RFC_SECRET_SHA512 = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii'
)

describe('base32', () => {
  it('кодирует тестовые векторы RFC 4648 без padding', () => {
    const vectors = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ]
    for (const [plain, encoded] of vectors) {
      expect(encode(Buffer.from(plain, 'ascii'))).toBe(encoded)
      expect(decode(encoded).toString('ascii')).toBe(plain)
    }
  })

  it('кодирует секрет из векторов RFC', () => {
    expect(encode(RFC_SECRET)).toBe(RFC_SECRET_B32)
    expect(decode(RFC_SECRET_B32).toString('ascii')).toBe(RFC_SECRET_ASCII)
  })

  it('переживает round-trip на случайных данных любой длины', () => {
    for (let length = 0; length <= 40; length += 1) {
      const source = randomBytes(length)
      expect(decode(encode(source)).equals(source)).toBe(true)
    }
  })

  it('не зависит от регистра и игнорирует пробелы с дефисами', () => {
    const grouped = 'gezd gnbv-gy3t qojq GEZD-gnbv gy3t-QOJQ'
    expect(decode(grouped).equals(RFC_SECRET)).toBe(true)
  })

  it('принимает хвостовой padding из чужих генераторов', () => {
    expect(decode('MZXW6===').toString('ascii')).toBe('foo')
  })

  it('отвергает недопустимые символы, длину и мусор в хвосте', () => {
    // '1', '8' и '0' в алфавит RFC 4648 не входят.
    expect(() => decode('MZXW1')).toThrow(/недопустимый символ/)
    // 9 символов — невозможная длина: n % 8 === 1.
    expect(() => decode('MZXW6YTBO')).toThrow(/некорректная длина/)
    // 'MZXW7' вместо 'MZXW6': два добивочных бита ненулевые.
    expect(() => decode('MZXW7')).toThrow(/ненулевые биты/)
    expect(() => decode(123)).toThrow(TypeError)
  })
})

describe('hotp — векторы RFC 4226 Appendix D', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ]

  it.each(expected.map((code, counter) => [counter, code]))(
    'counter=%i -> %s',
    (counter, code) => {
      expect(hotp(RFC_SECRET, counter, 6, 'SHA1')).toBe(code)
    }
  )

  it('принимает секрет строкой base32 наравне с байтами', () => {
    expect(hotp(RFC_SECRET_B32, 0, 6, 'SHA1')).toBe('755224')
  })
})

describe('totpCode — векторы RFC 6238 Appendix B', () => {
  // В таблице RFC коды восьмизначные, поэтому digits: 8 обязателен.
  const sha1Vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]

  it.each(sha1Vectors)('SHA1, T=%i -> %s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, { timeMs: seconds * 1000, digits: 8, algorithm: 'SHA1' })).toBe(code)
  })

  it.each(sha1Vectors)('SHA1 из base32-секрета, T=%i -> %s', (seconds, code) => {
    expect(totpCode(RFC_SECRET_B32, { timeMs: seconds * 1000, digits: 8 })).toBe(code)
  })

  it.each([
    [59, '46119246'],
    [1111111109, '68084774'],
    [1111111111, '67062674'],
    [1234567890, '91819424'],
    [2000000000, '90698825'],
    [20000000000, '77737706'],
  ])('SHA256, T=%i -> %s', (seconds, code) => {
    expect(
      totpCode(RFC_SECRET_SHA256, { timeMs: seconds * 1000, digits: 8, algorithm: 'SHA256' })
    ).toBe(code)
  })

  it.each([
    [59, '90693936'],
    [1111111109, '25091201'],
    [1111111111, '99943326'],
    [1234567890, '93441116'],
    [2000000000, '38618901'],
    [20000000000, '47863826'],
  ])('SHA512, T=%i -> %s', (seconds, code) => {
    expect(
      totpCode(RFC_SECRET_SHA512, { timeMs: seconds * 1000, digits: 8, algorithm: 'SHA512' })
    ).toBe(code)
  })

  it('код не меняется внутри шага и меняется на его границе', () => {
    const inStep = totpCode(RFC_SECRET, { timeMs: 60_000, digits: 8 })
    expect(totpCode(RFC_SECRET, { timeMs: 89_999, digits: 8 })).toBe(inStep)
    expect(totpCode(RFC_SECRET, { timeMs: 90_000, digits: 8 })).not.toBe(inStep)
  })

  it('отвергает некорректные digits, period и алгоритм', () => {
    expect(() => totpCode(RFC_SECRET, { digits: 9 })).toThrow(/digits/)
    expect(() => totpCode(RFC_SECRET, { period: 0 })).toThrow(/period/)
    expect(() => totpCode(RFC_SECRET, { algorithm: 'MD5' })).toThrow(/алгоритм/)
  })
})

describe('verifyTotp', () => {
  const secret = RFC_SECRET_B32
  // Середина шага 3333333: время подобрано так, чтобы соседние шаги были
  // целиком внутри диапазона и тест не зависел от округления.
  const now = 100_000_000_000
  const step = Math.floor(now / 1000 / 30)

  it('принимает код текущего шага и сообщает его номер', () => {
    const code = totpCode(secret, { timeMs: now })
    expect(verifyTotp(secret, code, { timeMs: now })).toEqual({ ok: true, matchedStep: step })
  })

  it('принимает соседние шаги в окне ±1', () => {
    const previous = totpCode(secret, { timeMs: now - 30_000 })
    const next = totpCode(secret, { timeMs: now + 30_000 })

    expect(verifyTotp(secret, previous, { timeMs: now })).toEqual({
      ok: true,
      matchedStep: step - 1,
    })
    expect(verifyTotp(secret, next, { timeMs: now })).toEqual({ ok: true, matchedStep: step + 1 })
  })

  it('отвергает шаги за пределами окна', () => {
    const tooOld = totpCode(secret, { timeMs: now - 60_000 })
    const tooNew = totpCode(secret, { timeMs: now + 60_000 })

    expect(verifyTotp(secret, tooOld, { timeMs: now }).ok).toBe(false)
    expect(verifyTotp(secret, tooNew, { timeMs: now }).ok).toBe(false)
  })

  it('window: 0 сужает проверку до текущего шага', () => {
    const previous = totpCode(secret, { timeMs: now - 30_000 })
    expect(verifyTotp(secret, previous, { timeMs: now, window: 0 }).ok).toBe(false)
    expect(verifyTotp(secret, totpCode(secret, { timeMs: now }), { timeMs: now, window: 0 }).ok).toBe(
      true
    )
  })

  it('window: 2 расширяет окно', () => {
    const older = totpCode(secret, { timeMs: now - 60_000 })
    expect(verifyTotp(secret, older, { timeMs: now, window: 2 })).toEqual({
      ok: true,
      matchedStep: step - 2,
    })
  })

  it('отказывает при повторном использовании уже принятого кода', () => {
    const code = totpCode(secret, { timeMs: now })
    const first = verifyTotp(secret, code, { timeMs: now })
    expect(first.ok).toBe(true)

    const replay = verifyTotp(secret, code, { timeMs: now, lastUsedStep: first.matchedStep })
    expect(replay).toEqual({ ok: false, reason: 'reused' })
  })

  it('отказывает и в коде более старого шага, чем уже принятый', () => {
    // Классическая атака: перехваченный код предыдущего шага всё ещё попадает
    // в окно, но он не новее уже израсходованного.
    const previous = totpCode(secret, { timeMs: now - 30_000 })
    expect(verifyTotp(secret, previous, { timeMs: now, lastUsedStep: step })).toEqual({
      ok: false,
      reason: 'reused',
    })
  })

  it('пропускает код следующего шага после уже принятого', () => {
    const next = totpCode(secret, { timeMs: now + 30_000 })
    expect(verifyTotp(secret, next, { timeMs: now, lastUsedStep: step })).toEqual({
      ok: true,
      matchedStep: step + 1,
    })
  })

  it('lastUsedStep === 0 не считается отсутствующим', () => {
    // Шаг 0 — валидное значение, а не «ещё не использован»: проверка
    // на != null, а не на truthy.
    const code = totpCode(secret, { timeMs: 0 })
    expect(verifyTotp(secret, code, { timeMs: 0, window: 0, lastUsedStep: 0 })).toEqual({
      ok: false,
      reason: 'reused',
    })
  })

  it('терпит пробелы и дефисы во введённом коде', () => {
    const code = totpCode(secret, { timeMs: now })
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    expect(verifyTotp(secret, spaced, { timeMs: now }).ok).toBe(true)
  })

  it('отвергает мусор вместо кода без падения', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, {}]) {
      expect(verifyTotp(secret, bad, { timeMs: now })).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  it('отвергает верный по формату, но чужой код', () => {
    const own = totpCode(secret, { timeMs: now })
    const alien = totpCode(generateSecret(), { timeMs: now })
    expect(alien).not.toBe(own)
    expect(verifyTotp(secret, alien, { timeMs: now })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('не проверяет код чужой длины как валидный при digits: 8', () => {
    const code8 = totpCode(secret, { timeMs: now, digits: 8 })
    expect(verifyTotp(secret, code8, { timeMs: now, digits: 8 }).ok).toBe(true)
    expect(verifyTotp(secret, code8, { timeMs: now }).reason).toBe('malformed')
  })

  it('отвергает отрицательное окно', () => {
    expect(() => verifyTotp(secret, '000000', { timeMs: now, window: -1 })).toThrow(/window/)
  })
})

describe('generateSecret', () => {
  it('даёт 160 бит в base32 без padding', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(decode(secret)).toHaveLength(20)
  })

  it('не повторяется', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()))
    expect(secrets.size).toBe(50)
  })
})

describe('buildOtpauthUri', () => {
  const secret = RFC_SECRET_B32

  it('собирает ссылку в формате, который читает Google Authenticator', () => {
    expect(buildOtpauthUri({ secret, account: 'admin@prohvac.uz' })).toBe(
      `otpauth://totp/PROHVAC:admin%40prohvac.uz?secret=${secret}` +
        '&issuer=PROHVAC&algorithm=SHA1&digits=6&period=30'
    )
  })

  it('дублирует issuer в label и в query', () => {
    const uri = buildOtpauthUri({ secret, account: 'admin', issuer: 'ACME Inc' })
    expect(uri).toContain('otpauth://totp/ACME%20Inc:admin?')
    expect(uri).toContain('issuer=ACME%20Inc')
  })

  it('экранирует служебные символы в account, не ломая структуру ссылки', () => {
    const uri = buildOtpauthUri({ secret, account: 'a/b?c#d:e' })
    const { pathname, searchParams } = new URL(uri)
    expect(decodeURIComponent(pathname)).toBe('/PROHVAC:a/b?c#d:e')
    expect(searchParams.get('secret')).toBe(secret)
  })

  it('пробрасывает нестандартные параметры', () => {
    const uri = buildOtpauthUri({
      secret,
      account: 'admin',
      digits: 8,
      period: 60,
      algorithm: 'sha256',
    })
    expect(uri).toContain('algorithm=SHA256')
    expect(uri).toContain('digits=8')
    expect(uri).toContain('period=60')
  })

  it('отвергает пустые обязательные поля и неизвестный алгоритм', () => {
    expect(() => buildOtpauthUri({ account: 'admin' })).toThrow(/secret/)
    expect(() => buildOtpauthUri({ secret })).toThrow(/account/)
    expect(() => buildOtpauthUri({ secret, account: 'admin', issuer: '' })).toThrow(/issuer/)
    expect(() => buildOtpauthUri({ secret, account: 'admin', algorithm: 'MD5' })).toThrow(/алгоритм/)
  })

  it('секрет из ссылки даёт тот же код, что и исходный', () => {
    const generated = generateSecret()
    const uri = buildOtpauthUri({ secret: generated, account: 'admin' })
    const fromUri = new URL(uri).searchParams.get('secret')
    expect(totpCode(fromUri, { timeMs: 1_700_000_000_000 })).toBe(
      totpCode(generated, { timeMs: 1_700_000_000_000 })
    )
  })
})

describe('generateRecoveryCodes', () => {
  it('по умолчанию отдаёт 10 кодов формата XXXXX-XXXXX', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    }
  })

  it('не использует похожие символы I, L, O и U', () => {
    const joined = generateRecoveryCodes(200).join('')
    expect(joined).not.toMatch(/[ILOU]/)
  })

  it('коды в наборе уникальны', () => {
    const codes = generateRecoveryCodes(100)
    expect(new Set(codes).size).toBe(100)
  })

  it('задействует весь алфавит из 32 символов', () => {
    // Косвенная проверка равномерности: на 500 кодах (5000 символов)
    // пропуск любого символа означал бы перекос генератора.
    const used = new Set(generateRecoveryCodes(500).join('').replace(/-/g, ''))
    expect(used.size).toBe(32)
  })

  it('отвергает некорректное количество', () => {
    expect(() => generateRecoveryCodes(0)).toThrow(/количество/)
    expect(() => generateRecoveryCodes(2.5)).toThrow(/количество/)
  })
})
