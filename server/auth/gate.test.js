import { describe, expect, it } from 'vitest'

import {
  GATE_COOKIE,
  GATE_TTL_MS,
  enterAdminGate,
  isAdminPath,
  issueGateCookie,
  shouldRevealAdmin,
  verifyGateCookie,
} from './gate.js'

// Ключи и путь тестовые: модуль не должен зависеть от переменных окружения,
// иначе тест начнёт падать или, хуже, зеленеть на чужом .env.local.
const SECRET = 'gate-secret-for-tests-0123456789'
const OTHER_SECRET = 'another-gate-secret-9876543210ab'
const SECRET_PATH = 'a1b2c3d4e5f6a7b8c9d0e1f2'

const NOW = 1_800_000_000_000

/** Минимальный ServerResponse: нужны только setHeader/getHeader. */
const fakeRes = () => {
  const headers = new Map()
  return {
    headers,
    headersSent: false,
    writableEnded: false,
    setHeader: (name, value) => headers.set(name, value),
    getHeader: (name) => headers.get(name),
  }
}

/** Значение куки из собранного Set-Cookie (до первого ';'). */
const cookieValue = (setCookie) => {
  const pair = setCookie.split(';')[0]
  return pair.slice(pair.indexOf('=') + 1)
}

const reqWith = (value) => ({ headers: { cookie: `${GATE_COOKIE}=${value}` } })

const issue = (options = {}) => issueGateCookie(fakeRes(), { now: NOW, secret: SECRET, ...options })

const validValue = (options = {}) => cookieValue(issue(options))

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64url')

const cfg = (overrides = {}) => ({
  adminSecretPath: SECRET_PATH,
  adminLegacyPathEnabled: false,
  adminRequireGate: true,
  gateSecret: SECRET,
  ...overrides,
})

describe('issueGateCookie', () => {
  it('ставит __Host-куку с атрибутами, при которых её нельзя подсадить', () => {
    const cookie = issue()

    expect(cookie.startsWith(`${GATE_COOKIE}=`)).toBe(true)
    expect(cookie).toContain('Max-Age=1800')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    // __Host- запрещает Domain: с ним куку мог бы поставить соседний поддомен.
    expect(cookie).not.toContain('Domain=')
  })

  it('значение — base64url(срок) и подпись через точку', () => {
    const [payload, signature, ...rest] = validValue().split('.')

    expect(rest).toHaveLength(0)
    expect(Buffer.from(payload, 'base64url').toString('utf8')).toBe(String(NOW + GATE_TTL_MS))
    expect(signature).toHaveLength(43)
  })

  it('не затирает Set-Cookie, выставленный сессией в том же ответе', () => {
    const res = fakeRes()
    res.setHeader('Set-Cookie', '__Host-pv_sid=abc; Path=/')

    const cookie = issueGateCookie(res, { now: NOW, secret: SECRET })

    expect(res.getHeader('Set-Cookie')).toEqual(['__Host-pv_sid=abc; Path=/', cookie])
  })

  it('падает с пустым GATE_SECRET, а не подписывает пустым ключом', () => {
    expect(() => issueGateCookie(fakeRes(), { now: NOW, secret: '' })).toThrow(/GATE_SECRET/)
  })

  it('на уже отправленном ответе ничего не пишет, но значение возвращает', () => {
    const res = fakeRes()
    res.headersSent = true

    const cookie = issueGateCookie(res, { now: NOW, secret: SECRET })

    expect(cookie).toContain(GATE_COOKIE)
    expect(res.getHeader('Set-Cookie')).toBeUndefined()
  })
})

describe('verifyGateCookie', () => {
  it('принимает свежую куку', () => {
    expect(verifyGateCookie(reqWith(validValue()), { now: NOW, secret: SECRET })).toBe(true)
    // За секунду до конца срока — ещё действует.
    const almost = NOW + GATE_TTL_MS - 1
    expect(verifyGateCookie(reqWith(validValue()), { now: almost, secret: SECRET })).toBe(true)
  })

  it('отвергает просроченную', () => {
    const value = validValue()

    // Ровно в момент истечения кука уже не действует: срок сравнивается строго.
    expect(verifyGateCookie(reqWith(value), { now: NOW + GATE_TTL_MS, secret: SECRET })).toBe(false)
    expect(verifyGateCookie(reqWith(value), { now: NOW + GATE_TTL_MS + 1, secret: SECRET }))
      .toBe(false)
    // Час спустя — тем более.
    expect(verifyGateCookie(reqWith(value), { now: NOW + 3_600_000, secret: SECRET })).toBe(false)
  })

  it('отвергает подделанную подпись', () => {
    const [payload, signature] = validValue().split('.')
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`

    expect(verifyGateCookie(reqWith(`${payload}.${flipped}`), { now: NOW, secret: SECRET }))
      .toBe(false)
    // Подпись правильной длины, но целиком чужая.
    expect(verifyGateCookie(reqWith(`${payload}.${'A'.repeat(43)}`), { now: NOW, secret: SECRET }))
      .toBe(false)
  })

  it('отвергает подменённый срок при сохранённой старой подписи', () => {
    const [, signature] = validValue().split('.')
    const stretched = `${b64(NOW + 30 * 24 * 3_600_000)}.${signature}`

    expect(verifyGateCookie(reqWith(stretched), { now: NOW, secret: SECRET })).toBe(false)
  })

  it('отвергает куку, подписанную другим GATE_SECRET', () => {
    const foreign = cookieValue(issue({ secret: OTHER_SECRET }))

    expect(verifyGateCookie(reqWith(foreign), { now: NOW, secret: SECRET })).toBe(false)
    // Проверка тем же ключом, которым подписали, проходит — значит дело
    // именно в ключе, а не в сломанном формате.
    expect(verifyGateCookie(reqWith(foreign), { now: NOW, secret: OTHER_SECRET })).toBe(true)
  })

  it('не падает на мусоре и на отсутствии куки', () => {
    const garbage = [
      '',
      'no-dot-here',
      '.',
      `.${'A'.repeat(43)}`,
      `${b64(NOW + GATE_TTL_MS)}.`,
      `${b64(NOW + GATE_TTL_MS)}.short`,
      `${b64(NOW + GATE_TTL_MS)}.${'A'.repeat(43)}.${'A'.repeat(43)}`,
      'x'.repeat(4096),
      b64('не число'),
    ]
    for (const value of garbage) {
      expect(verifyGateCookie(reqWith(value), { now: NOW, secret: SECRET })).toBe(false)
    }

    expect(verifyGateCookie({ headers: {} }, { now: NOW, secret: SECRET })).toBe(false)
    expect(verifyGateCookie({}, { now: NOW, secret: SECRET })).toBe(false)
    expect(verifyGateCookie(null, { now: NOW, secret: SECRET })).toBe(false)
  })

  it('без ключа отказывает, а не открывает', () => {
    expect(verifyGateCookie(reqWith(validValue()), { now: NOW, secret: '' })).toBe(false)
  })
})

describe('isAdminPath', () => {
  it('узнаёт секретный путь и его подпути', () => {
    expect(isAdminPath(`/${SECRET_PATH}`, cfg())).toEqual({ isAdmin: true, isSecretEntry: true })
    expect(isAdminPath(`/${SECRET_PATH}/leads`, cfg()))
      .toEqual({ isAdmin: true, isSecretEntry: true })
  })

  it('не срабатывает на похожем пути', () => {
    for (const path of [
      `/${SECRET_PATH}x`,
      `/${SECRET_PATH.slice(0, -1)}`,
      `/x${SECRET_PATH}`,
      `/${SECRET_PATH.toUpperCase()}`,
      `/leads/${SECRET_PATH}`,
    ]) {
      expect(isAdminPath(path, cfg()).isAdmin).toBe(false)
    }
  })

  it('при выключенном легаси /admin — обычный несуществующий путь', () => {
    expect(isAdminPath('/admin', cfg())).toEqual({ isAdmin: false, isSecretEntry: false })
    expect(isAdminPath('/admin/leads', cfg()).isAdmin).toBe(false)
  })

  it('при включённом легаси /admin — админский путь, но не секретный вход', () => {
    const legacy = cfg({ adminLegacyPathEnabled: true })

    expect(isAdminPath('/admin', legacy)).toEqual({ isAdmin: true, isSecretEntry: false })
    expect(isAdminPath('/admin/leads', legacy)).toEqual({ isAdmin: true, isSecretEntry: false })
    // Секретный путь при этом продолжает работать.
    expect(isAdminPath(`/${SECRET_PATH}`, legacy).isSecretEntry).toBe(true)
  })

  it('пустой adminSecretPath не совпадает ни с чем', () => {
    const broken = cfg({ adminSecretPath: '' })

    for (const path of ['/', '//', '/anything', `/${SECRET_PATH}`]) {
      expect(isAdminPath(path, broken).isAdmin).toBe(false)
    }
  })

  it('игнорирует обычные адреса сайта и мусор вместо пути', () => {
    for (const path of ['/', '/api/lead', '/media/x.jpg', '', 'admin', null, undefined, 42]) {
      expect(isAdminPath(path, cfg({ adminLegacyPathEnabled: true })).isAdmin).toBe(false)
    }
  })
})

describe('shouldRevealAdmin', () => {
  it('с выключенным гейтом показывает админку всем', () => {
    const open = cfg({ adminRequireGate: false })

    expect(shouldRevealAdmin({ headers: {} }, open)).toBe(true)
  })

  it('с включённым гейтом без куки прячет', () => {
    expect(shouldRevealAdmin({ headers: {} }, cfg())).toBe(false)
    expect(shouldRevealAdmin(reqWith('подделка'), cfg())).toBe(false)
  })

  it('с включённым гейтом и валидной кукой показывает', () => {
    expect(shouldRevealAdmin(reqWith(validValue({ now: Date.now() })), cfg())).toBe(true)
  })

  it('просроченная кука снова прячет админку', () => {
    const stale = validValue({ now: Date.now() - GATE_TTL_MS - 1000 })

    expect(shouldRevealAdmin(reqWith(stale), cfg())).toBe(false)
  })

  it('заход по секретному пути пускает без куки — иначе первый вход невозможен', () => {
    expect(shouldRevealAdmin({ headers: {} }, cfg(), { isSecretEntry: true })).toBe(true)
  })
})

describe('enterAdminGate', () => {
  it('секретный путь показывает админку и выдаёт куку', () => {
    const res = fakeRes()
    const result = enterAdminGate({ headers: {} }, res, `/${SECRET_PATH}`, cfg())

    expect(result).toEqual({ isAdmin: true, isSecretEntry: true, reveal: true })

    const [cookie] = res.getHeader('Set-Cookie')
    expect(verifyGateCookie(reqWith(cookieValue(cookie)), { secret: SECRET })).toBe(true)
  })

  it('легаси /admin без куки прячется и куку не выдаёт', () => {
    const res = fakeRes()
    const legacy = cfg({ adminLegacyPathEnabled: true })
    const result = enterAdminGate({ headers: {} }, res, '/admin', legacy)

    expect(result).toEqual({ isAdmin: true, isSecretEntry: false, reveal: false })
    expect(res.getHeader('Set-Cookie')).toBeUndefined()
  })

  it('легаси /admin открывается после захода по секретному пути', () => {
    const legacy = cfg({ adminLegacyPathEnabled: true })

    const res = fakeRes()
    enterAdminGate({ headers: {} }, res, `/${SECRET_PATH}`, legacy)
    const req = reqWith(cookieValue(res.getHeader('Set-Cookie')[0]))

    expect(enterAdminGate(req, fakeRes(), '/admin', legacy).reveal).toBe(true)
  })

  it('с выключенным гейтом кука не нужна и не выдаётся', () => {
    const res = fakeRes()
    const open = cfg({ adminRequireGate: false })

    expect(enterAdminGate({ headers: {} }, res, `/${SECRET_PATH}`, open).reveal).toBe(true)
    expect(res.getHeader('Set-Cookie')).toBeUndefined()
  })

  it('обычный путь админкой не считается', () => {
    const res = fakeRes()
    const result = enterAdminGate({ headers: {} }, res, '/api/lead', cfg())

    expect(result).toEqual({ isAdmin: false, isSecretEntry: false, reveal: false })
    expect(res.getHeader('Set-Cookie')).toBeUndefined()
  })
})
