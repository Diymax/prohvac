import { describe, expect, it } from 'vitest'

import { PURPOSE, deriveKey, open, preview, seal } from './secretbox.js'

// Заведомо ненастоящие значения: тесты не должны содержать боевых секретов.
//
// Маркер NOT-A-REAL-TOKEN обязателен. Фикстура повторяет форму токена Telegram
// (десять цифр, двоеточие, случайный хвост), и сканер секретов в
// scripts/secret-patterns.mjs иначе не отличил бы её от настоящего токена.
// Маркер — единственное разрешённое исключение: ослаблять сам паттерн нельзя,
// а путь в allowlist со временем накрыл бы и реальную утечку.
const TOKEN = '1234567890:NOT-A-REAL-TOKEN-TEST-FIXTURE-0000000'
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

describe('seal', () => {
  it('отдаёт части ровно тех размеров, что заданы схемой БД', () => {
    const { ct, iv, tag } = seal(TOKEN, PURPOSE.telegramToken)

    expect(Buffer.isBuffer(ct)).toBe(true)
    expect(iv).toHaveLength(12)
    expect(tag).toHaveLength(16)
    // GCM — потоковый режим, длина шифротекста равна длине открытого текста.
    expect(ct).toHaveLength(Buffer.byteLength(TOKEN, 'utf8'))
    expect(ct.toString('utf8')).not.toContain('TEST')
  })

  it('шифрует один и тот же секрет каждый раз по-новому — nonce случайный', () => {
    const first = seal(TOKEN, PURPOSE.telegramToken)
    const second = seal(TOKEN, PURPOSE.telegramToken)

    expect(first.iv.equals(second.iv)).toBe(false)
    expect(first.ct.equals(second.ct)).toBe(false)
  })

  it('отказывается шифровать не-строку, пустое и слишком длинное', () => {
    expect(() => seal(null, PURPOSE.deeplKey)).toThrow(TypeError)
    expect(() => seal(Buffer.from(TOKEN), PURPOSE.deeplKey)).toThrow(TypeError)
    expect(() => seal('', PURPOSE.deeplKey)).toThrow(RangeError)
    expect(() => seal('x'.repeat(4097), PURPOSE.deeplKey)).toThrow(RangeError)
  })

  it('отказывается работать с некорректным purpose', () => {
    for (const bad of ['', 'ab', 'Totp-Secret', 'totp_secret', 'x'.repeat(33), null, 42]) {
      expect(() => seal(TOKEN, bad)).toThrow(TypeError)
    }
  })
})

describe('open', () => {
  it('раунд-трип: расшифровывается ровно то, что зашифровали', () => {
    expect(open(seal(TOKEN, PURPOSE.telegramToken), PURPOSE.telegramToken)).toBe(TOKEN)
    expect(open(seal(TOTP, PURPOSE.totpSecret), PURPOSE.totpSecret)).toBe(TOTP)
  })

  it('не портит не-ASCII: секрет возвращается посимвольно тем же', () => {
    const value = 'ключ-провайдера-переводов-«DeepL»-ЁЁ-🙂'
    expect(open(seal(value, PURPOSE.deeplKey), PURPOSE.deeplKey)).toBe(value)
  })

  it('принимает Uint8Array — node:sqlite отдаёт BLOB именно так', () => {
    const box = seal(TOKEN, PURPOSE.telegramToken)
    const asBlob = {
      ct: new Uint8Array(box.ct),
      iv: new Uint8Array(box.iv),
      tag: new Uint8Array(box.tag),
    }

    expect(open(asBlob, PURPOSE.telegramToken)).toBe(TOKEN)
  })

  it('бросает при испорченном теге', () => {
    const box = seal(TOKEN, PURPOSE.telegramToken)
    box.tag[0] ^= 0x01

    expect(() => open(box, PURPOSE.telegramToken)).toThrow(/не удалось расшифровать/)
  })

  it('бросает при испорченном шифротексте и при испорченном nonce', () => {
    const withBadCt = seal(TOKEN, PURPOSE.telegramToken)
    withBadCt.ct[3] ^= 0x80
    expect(() => open(withBadCt, PURPOSE.telegramToken)).toThrow(/не удалось расшифровать/)

    const withBadIv = seal(TOKEN, PURPOSE.telegramToken)
    withBadIv.iv[11] ^= 0x40
    expect(() => open(withBadIv, PURPOSE.telegramToken)).toThrow(/не удалось расшифровать/)
  })

  it('бросает на обрезанных iv и tag, не доходя до расшифровки', () => {
    const box = seal(TOKEN, PURPOSE.telegramToken)

    expect(() => open({ ...box, iv: box.iv.subarray(0, 11) }, PURPOSE.telegramToken)).toThrow(
      RangeError
    )
    expect(() => open({ ...box, tag: box.tag.subarray(0, 15) }, PURPOSE.telegramToken)).toThrow(
      RangeError
    )
  })

  it('бросает на мусоре вместо коробки', () => {
    expect(() => open(null, PURPOSE.telegramToken)).toThrow(TypeError)
    expect(() => open('шифротекст', PURPOSE.telegramToken)).toThrow(TypeError)
    expect(() => open({}, PURPOSE.telegramToken)).toThrow(TypeError)
    expect(() => open({ ct: 'a', iv: 'b', tag: 'c' }, PURPOSE.telegramToken)).toThrow(TypeError)
  })
})

describe('разделение по purpose', () => {
  it('даёт разные ключи на каждое назначение', () => {
    const telegram = deriveKey(PURPOSE.telegramToken)
    const totp = deriveKey(PURPOSE.totpSecret)

    expect(telegram).toHaveLength(32)
    expect(telegram.equals(totp)).toBe(false)
    // Вывод детерминированный: иначе после рестарта процесса база
    // не расшифровалась бы.
    expect(deriveKey(PURPOSE.telegramToken).equals(telegram)).toBe(true)
  })

  it('шифрует одно и то же значение по-разному', () => {
    const telegram = seal(TOKEN, PURPOSE.telegramToken)
    const deepl = seal(TOKEN, PURPOSE.deeplKey)

    // Само по себе несовпадение ct доказывает мало — оно вышло бы и от
    // случайного nonce. Разделение ключей проверяют соседние тесты:
    // deriveKey отдаёт разные ключи, а чужой purpose не расшифровывает.
    expect(telegram.ct.equals(deepl.ct)).toBe(false)
    expect(telegram.tag.equals(deepl.tag)).toBe(false)
  })

  it('не расшифровывается чужим purpose — перестановка колонок не проходит', () => {
    const box = seal(TOTP, PURPOSE.totpSecret)

    expect(() => open(box, PURPOSE.telegramToken)).toThrow(/не удалось расшифровать/)
    expect(() => open(box, PURPOSE.deeplKey)).toThrow(/не удалось расшифровать/)
    expect(open(box, PURPOSE.totpSecret)).toBe(TOTP)
  })
})

describe('preview', () => {
  it('оставляет префикс схемы и последние четыре символа', () => {
    expect(preview('dpl_0123456789abcdef4f2a')).toBe('dpl_****4f2a')
    expect(preview('fixture_abcdefghijklmnop9999')).toBe('fixture_****9999')
  })

  it('не показывает id бота в токене Telegram', () => {
    // Префикс до двоеточия — половина токена, показывать его нельзя,
    // поэтому шаблон префикса требует буквы в начале.
    expect(preview(TOKEN)).toBe('****0000')
  })

  it('прячет короткое значение целиком', () => {
    expect(preview('короткий')).toBe('****')
    expect(preview('dpl_short')).toBe('dpl_****')
  })

  it('на пустом значении возвращает пустую строку', () => {
    expect(preview('')).toBe('')
    expect(preview('   ')).toBe('')
    expect(preview(null)).toBe('')
    expect(preview(undefined)).toBe('')
    expect(preview(12345)).toBe('')
  })
})
