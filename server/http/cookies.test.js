import { describe, expect, it } from 'vitest'
import { parseCookies, serializeCookie } from './cookies.js'

const req = (cookie) => ({ headers: cookie == null ? {} : { cookie } })

describe('parseCookies', () => {
  it('разбирает несколько кук', () => {
    const jar = parseCookies(req('sid=abc; csrf=xyz; theme=dark'))
    expect({ ...jar }).toEqual({ sid: 'abc', csrf: 'xyz', theme: 'dark' })
  })

  it('терпит лишние пробелы и хвостовую точку с запятой', () => {
    const jar = parseCookies(req('  sid=abc ;   csrf=xyz ;'))
    expect(jar.sid).toBe('abc')
    expect(jar.csrf).toBe('xyz')
  })

  it('декодирует percent-encoding и оставляет знак "=" внутри значения', () => {
    const jar = parseCookies(req('q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82; token=a=b=c'))
    expect(jar.q).toBe('привет')
    expect(jar.token).toBe('a=b=c')
  })

  it('снимает кавычки с quoted-string', () => {
    expect(parseCookies(req('sid="abc"')).sid).toBe('abc')
  })

  it('не падает на битом percent-encoding', () => {
    expect(parseCookies(req('sid=%zz')).sid).toBe('%zz')
  })

  it('возвращает пустой объект без заголовка и на мусоре', () => {
    expect({ ...parseCookies(req()) }).toEqual({})
    expect({ ...parseCookies(req('   '))} ).toEqual({})
    expect({ ...parseCookies(req('flag; =empty'))} ).toEqual({})
    expect({ ...parseCookies({}) }).toEqual({})
  })

  it('при дубликате берёт первое вхождение', () => {
    expect(parseCookies(req('sid=first; sid=second')).sid).toBe('first')
  })

  it('не даёт куке подменить прототип', () => {
    const jar = parseCookies(req('__proto__=polluted; sid=abc'))
    expect(jar.__proto__).toBe('polluted')
    expect({}.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(jar)).toBeNull()
  })
})

describe('serializeCookie', () => {
  it('собирает минимальную куку', () => {
    expect(serializeCookie('sid', 'abc')).toBe('sid=abc')
  })

  it('экранирует значение', () => {
    expect(serializeCookie('sid', 'a b;c=d')).toBe('sid=a%20b%3Bc%3Dd')
    expect(serializeCookie('q', 'привет')).toBe('q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82')
    expect(serializeCookie('sid', '')).toBe('sid=')
    expect(serializeCookie('sid', null)).toBe('sid=')
  })

  it('складывает все атрибуты', () => {
    const out = serializeCookie('sid', 'abc', {
      maxAge: 3600,
      path: '/',
      domain: 'sub-domain.example.com',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    })
    expect(out).toBe(
      'sid=abc; Max-Age=3600; Path=/; Domain=sub-domain.example.com; SameSite=Lax; Secure; HttpOnly'
    )
  })

  it('пишет Expires в формате HTTP-date', () => {
    const out = serializeCookie('sid', 'abc', { expires: new Date(Date.UTC(2030, 0, 2, 3, 4, 5)) })
    expect(out).toBe('sid=abc; Expires=Wed, 02 Jan 2030 03:04:05 GMT')
  })

  it('нормализует SameSite', () => {
    expect(serializeCookie('a', '1', { sameSite: 'STRICT' })).toBe('a=1; SameSite=Strict')
    expect(serializeCookie('a', '1', { sameSite: 'none', secure: true })).toBe(
      'a=1; SameSite=None; Secure'
    )
  })

  it('отвергает Max-Age=0 не путая с отсутствием опции', () => {
    expect(serializeCookie('sid', '', { maxAge: 0 })).toBe('sid=; Max-Age=0')
  })

  it('ругается на неверные имя и атрибуты', () => {
    expect(() => serializeCookie('bad name', '1')).toThrow(/недопустимое имя/)
    expect(() => serializeCookie('sid=x', '1')).toThrow(/недопустимое имя/)
    expect(() => serializeCookie('sid', '1', { maxAge: 1.5 })).toThrow(/Max-Age/)
    expect(() => serializeCookie('sid', '1', { expires: 'вчера' })).toThrow(/Expires/)
    expect(() => serializeCookie('sid', '1', { path: '/a;Domain=evil.com' })).toThrow(/Path/)
    expect(() => serializeCookie('sid', '1', { domain: 'evil.com\r\nSet-Cookie: x=1' })).toThrow(
      /Domain/
    )
    expect(() => serializeCookie('sid', '1', { sameSite: 'maybe' })).toThrow(/SameSite/)
    expect(() => serializeCookie('sid', '1', { sameSite: 'none' })).toThrow(
      /SameSite=None требует Secure/
    )
  })
})

describe('serializeCookie: инварианты префиксов', () => {
  const host = { secure: true, path: '/', httpOnly: true, sameSite: 'strict' }

  it('пропускает корректную __Host- куку', () => {
    expect(serializeCookie('__Host-sid', 'abc', host)).toBe(
      '__Host-sid=abc; Path=/; SameSite=Strict; Secure; HttpOnly'
    )
  })

  it('требует Secure', () => {
    expect(() => serializeCookie('__Host-sid', 'abc', { ...host, secure: false })).toThrow(
      /__Host- требует Secure/
    )
  })

  it("требует Path='/'", () => {
    expect(() => serializeCookie('__Host-sid', 'abc', { ...host, path: '/admin' })).toThrow(
      /__Host- требует Path/
    )
    expect(() => serializeCookie('__Host-sid', 'abc', { secure: true })).toThrow(
      /__Host- требует Path/
    )
  })

  it('запрещает Domain — иначе префикс не защищает от соседнего поддомена', () => {
    expect(() =>
      serializeCookie('__Host-sid', 'abc', { ...host, domain: 'example.com' })
    ).toThrow(/__Host- запрещает Domain/)
  })

  it('требует Secure для __Secure-', () => {
    expect(() => serializeCookie('__Secure-sid', 'abc', { path: '/admin' })).toThrow(
      /__Secure- требует Secure/
    )
    expect(serializeCookie('__Secure-sid', 'abc', { path: '/admin', secure: true })).toBe(
      '__Secure-sid=abc; Path=/admin; Secure'
    )
  })
})
