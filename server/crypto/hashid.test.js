import { describe, expect, it } from 'vitest'

import { hashIp, hashUa } from './hashid.js'

// Адреса из диапазонов, зарезервированных под документацию (RFC 5737, 3849).
const IPV4 = '203.0.113.7'
const IPV6 = '2001:db8:1234:5678:9abc:def0:1234:5678'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestAgent/1.0'

const HEX64 = /^[0-9a-f]{64}$/

describe('hashIp', () => {
  it('отдаёт 64 hex-символа в нижнем регистре — как требует CHECK в схеме', () => {
    expect(hashIp(IPV4)).toMatch(HEX64)
    expect(hashIp(IPV6)).toMatch(HEX64)
    expect(hashIp(null)).toMatch(HEX64)
  })

  it('стабилен и не содержит исходного адреса', () => {
    expect(hashIp(IPV4)).toBe(hashIp(IPV4))
    expect(hashIp(IPV4)).not.toContain('203')
  })

  it('разные адреса — разные хеши', () => {
    expect(hashIp(IPV4)).not.toBe(hashIp('203.0.113.8'))
    expect(hashIp(IPV4)).not.toBe(hashIp(IPV6))
  })

  it('схлопывает записи одного адреса: порт, скобки, регистр, зона', () => {
    const v4 = hashIp(IPV4)
    expect(hashIp(` ${IPV4} `)).toBe(v4)
    expect(hashIp(`${IPV4}:54321`)).toBe(v4)
    // IPv4-mapped приходит, когда сокет слушает двойной стек.
    expect(hashIp(`::ffff:${IPV4}`)).toBe(v4)

    const v6 = hashIp('fe80::1')
    expect(hashIp('FE80::1')).toBe(v6)
    expect(hashIp('[fe80::1]:443')).toBe(v6)
    expect(hashIp('fe80::1%eth0')).toBe(v6)
    expect(hashIp('fe80:0:0:0:0:0:0:1')).toBe(v6)
    expect(hashIp('fe80:0000:0000:0000:0000:0000:0000:0001')).toBe(v6)
  })

  it('для IPv6 считает только /64: смена адреса внутри подсети не сбрасывает счётчик', () => {
    const prefix = hashIp(IPV6)
    expect(hashIp('2001:db8:1234:5678:ffff:ffff:ffff:ffff')).toBe(prefix)
    // Соседняя подсеть — уже другой клиент.
    expect(hashIp('2001:db8:1234:5679::1')).not.toBe(prefix)
  })

  it('неизвестный адрес попадает в общее ведро, а не отключает лимитер', () => {
    const unknown = hashIp(null)
    expect(hashIp(undefined)).toBe(unknown)
    expect(hashIp('')).toBe(unknown)
    expect(hashIp('   ')).toBe(unknown)
    // Клиент, приславший буквальное 'unknown', в это ведро не попадает:
    // иначе он подмешивал бы свои попытки к чужим.
    expect(hashIp('unknown')).not.toBe(unknown)
  })

  it('не падает на мусоре вместо адреса', () => {
    for (const value of ['не адрес', ':::::', '2001:db8::192.0.2.1', 42, {}, []]) {
      expect(hashIp(value)).toMatch(HEX64)
    }
  })
})

describe('hashUa', () => {
  it('отдаёт 64 hex-символа и стабилен', () => {
    expect(hashUa(UA)).toMatch(HEX64)
    expect(hashUa(UA)).toBe(hashUa(UA))
  })

  it('различает клиентов, в том числе по регистру', () => {
    expect(hashUa(UA)).not.toBe(hashUa(`${UA} Mobile`))
    expect(hashUa(UA)).not.toBe(hashUa(UA.toLowerCase()))
  })

  it('обрезает длинный заголовок, но одинаковое начало не склеивает с пустым', () => {
    const long = 'A'.repeat(4096)
    expect(hashUa(long)).toMatch(HEX64)
    expect(hashUa(long)).toBe(hashUa('A'.repeat(512)))
    expect(hashUa(long)).not.toBe(hashUa(''))
  })

  it('пустой заголовок даёт общий хеш, отличный от хеша адреса', () => {
    const unknown = hashUa('')
    expect(hashUa(null)).toBe(unknown)
    expect(hashUa(undefined)).toBe(unknown)
    // Ключи для IP и UA разные, поэтому «неизвестно» в двух колонках
    // не превращается в одинаковую строку.
    expect(unknown).not.toBe(hashIp(''))
  })
})
