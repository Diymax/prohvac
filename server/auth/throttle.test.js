import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HONEYPOT_PATHS,
  MAX_BLOCK_MS,
  SOFT_MAX_FAILS,
  SOFT_WINDOW_MS,
  STUFFING_MAX_USERS,
  createThrottle,
  isHoneypot,
} from './throttle.js'

// node:sqlite до сих пор помечен как experimental и в старых сборках Node
// отсутствует. Тесты с базой в таком случае пропускаем с внятной причиной
// в названии, а чистый isHoneypot проверяем всегда — он от базы не зависит.
let DatabaseSync = null
let unavailable = ''
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch (error) {
  unavailable = error.message
}

const describeDb = DatabaseSync ? describe : describe.skip
const suiteName = DatabaseSync
  ? 'createThrottle'
  : `createThrottle — пропущено: node:sqlite недоступен в Node ${process.version} (${unavailable})`

// Схема берётся из той же миграции, что уедет на хостинг: тест обязан падать,
// если CHECK или индекс в 001_init.sql разойдутся с ожиданиями модуля.
const SCHEMA = readFileSync(
  join(import.meta.dirname, '..', 'db', 'migrations', '001_init.sql'),
  'utf8'
).replace(/^\uFEFF/, '')

// ip_hash в схеме — ровно 64 знака hex (CHECK ловит попытку записать сырой IP).
const IP = 'a'.repeat(64)
const OTHER_IP = 'b'.repeat(64)

const BASE = 1_700_000_000_000
const HOUR = 3_600_000
const MINUTE = 60_000

const setup = () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return { db, throttle: createThrottle(db) }
}

const addUser = (db, username) => db
  .prepare(`INSERT INTO users (username, password_hash, role, failed_attempts, lock_level, locked_until)
            VALUES (?, 'x', 'owner', 7, 3, ?)`)
  .run(username, BASE + HOUR)

const readUser = (db, username) => db
  .prepare('SELECT failed_attempts, lock_level, locked_until FROM users WHERE username = ?')
  .get(username)

/** n неудач подряд с шагом в секунду. Возвращает результат последней. */
const failTimes = (throttle, n, { ipHash = IP, username = 'admin', from = BASE } = {}) => {
  let last = null
  for (let i = 0; i < n; i += 1) {
    last = throttle.registerFailure({ ipHash, username, now: from + i * 1_000 })
  }
  return last
}

describeDb(suiteName, () => {
  it('пишет попытку в журнал со всеми полями', () => {
    const { db, throttle } = setup()

    const row = throttle.recordAttempt({
      ipHash: IP,
      username: '  Admin  ',
      stage: 'totp',
      outcome: 'bad_totp',
      now: BASE,
    })
    expect(row.at).toBe(BASE)

    const saved = db.prepare('SELECT * FROM login_attempts WHERE id = ?').get(row.id)
    expect(saved).toMatchObject({
      at: BASE,
      username: 'Admin',
      ip_hash: IP,
      stage: 'totp',
      outcome: 'bad_totp',
    })
  })

  it('не даёт записать сырой IP или неизвестный этап', () => {
    const { throttle } = setup()

    expect(() => throttle.recordAttempt({ ipHash: '203.0.113.7' })).toThrow(TypeError)
    expect(() => throttle.recordAttempt({ ipHash: IP.toUpperCase() })).toThrow(TypeError)
    expect(() => throttle.recordAttempt({ ipHash: IP, stage: 'sms' })).toThrow(TypeError)
    expect(() => throttle.recordAttempt({ ipHash: IP, outcome: 'meh' })).toThrow(TypeError)
  })

  it('чистый адрес не блокирован и не тормозится', () => {
    const { throttle } = setup()
    expect(throttle.checkIp(IP, { now: BASE })).toEqual({
      blocked: false,
      until: 0,
      delayMs: 0,
      reason: null,
    })
  })

  it('наращивает задержку с каждой неудачей', () => {
    const { throttle } = setup()

    const delays = []
    for (let i = 0; i < 5; i += 1) {
      delays.push(throttle.registerFailure({ ipHash: IP, username: 'admin', now: BASE + i }).delayMs)
    }
    // Первые две неудачи бесплатны — это опечатка, а не перебор.
    expect(delays).toEqual([0, 0, 250, 500, 1_000])
    expect(throttle.checkIp(IP, { now: BASE + 10 }).delayMs).toBe(1_000)
  })

  it('считает неудачи по адресам раздельно', () => {
    const { throttle } = setup()

    failTimes(throttle, 5)
    expect(throttle.checkIp(OTHER_IP, { now: BASE + MINUTE }).delayMs).toBe(0)
  })

  it('наши собственные отказы не разгоняют счётчик', () => {
    const { throttle } = setup()

    // Заблокированный человек, который жмёт кнопку, не должен сам себе
    // продлевать наказание: 'locked' и 'rate_limited' — не попытки угадать.
    for (let i = 0; i < 30; i += 1) {
      throttle.recordAttempt({ ipHash: IP, username: 'admin', outcome: 'locked', now: BASE + i })
      throttle.recordAttempt({ ipHash: IP, username: 'admin', outcome: 'rate_limited', now: BASE + i })
    }
    expect(throttle.checkIp(IP, { now: BASE + MINUTE })).toMatchObject({
      blocked: false,
      delayMs: 0,
    })
  })

  it('после 10 неудач за 15 минут отвечает 429, но адрес не блокирует', () => {
    const { throttle } = setup()

    expect(failTimes(throttle, SOFT_MAX_FAILS - 1).blocked).toBe(false)

    const tenth = failTimes(throttle, 1, { from: BASE + (SOFT_MAX_FAILS - 1) * 1_000 })
    expect(tenth).toMatchObject({ blocked: true, reason: 'too_many_attempts', fails: 10 })
    // Retry-After считается от самой старой из десяти: именно тогда счётчик
    // опустится ниже порога, а не «через 15 минут от последнего запроса».
    expect(tenth.until).toBe(BASE + SOFT_WINDOW_MS)

    // За общим NAT сидит целый дом — на этой ступени адрес ещё не режется.
    expect(throttle.listBlocks()).toEqual([])
    expect(throttle.checkIp(IP, { now: BASE + MINUTE }).blocked).toBe(false)
  })

  it('старые неудачи выпадают из окна', () => {
    const { throttle } = setup()

    failTimes(throttle, SOFT_MAX_FAILS - 1)

    // Прошло 16 минут — предыдущая серия за пределами 15-минутного окна.
    const later = failTimes(throttle, 1, { from: BASE + 16 * MINUTE })
    expect(later).toMatchObject({ blocked: false, fails: 10 })
  })

  it('после 20 неудач за час блокирует адрес на 24 часа', () => {
    const { throttle } = setup()

    const result = failTimes(throttle, 20)
    expect(result).toMatchObject({ blocked: true, reason: 'ip_blocked', fails: 20 })
    expect(result.until).toBe(BASE + 19 * 1_000 + 24 * HOUR)

    const [block] = throttle.listBlocks({ now: BASE })
    expect(block).toMatchObject({
      ip_hash: IP,
      strikes: 1,
      reason: 'login_bruteforce',
      active: true,
    })
  })

  it('блокировка видна в checkIp и снимается сама по истечении срока', () => {
    const { throttle } = setup()
    throttle.blockIp(IP, { hours: 24, now: BASE })

    expect(throttle.checkIp(IP, { now: BASE + HOUR })).toMatchObject({
      blocked: true,
      until: BASE + 24 * HOUR,
      reason: 'login_bruteforce',
    })
    // Ровно на границе блокировки уже нет: сравнение строгое.
    expect(throttle.checkIp(IP, { now: BASE + 24 * HOUR }).blocked).toBe(false)
    // Строка при этом жива — в ней память о strikes.
    expect(throttle.listBlocks({ now: BASE + 24 * HOUR })[0]).toMatchObject({ active: false })
  })

  it('повторная блокировка наращивает strikes и удваивает срок', () => {
    const { throttle } = setup()

    const first = throttle.blockIp(IP, { hours: 24, now: BASE })
    expect(first).toMatchObject({ strikes: 1 })
    expect(first.blocked_until).toBe(BASE + 24 * HOUR)

    const second = throttle.blockIp(IP, { hours: 24, now: BASE + 25 * HOUR })
    expect(second).toMatchObject({ strikes: 2 })
    expect(second.blocked_until).toBe(BASE + 25 * HOUR + 48 * HOUR)

    const third = throttle.blockIp(IP, { hours: 24, now: BASE + 100 * HOUR })
    expect(third).toMatchObject({ strikes: 3 })
    expect(third.blocked_until).toBe(BASE + 100 * HOUR + 96 * HOUR)
  })

  it('срок блокировки упирается в потолок и не укорачивается', () => {
    const { throttle } = setup()

    let now = BASE
    let last = null
    for (let i = 0; i < 10; i += 1) {
      last = throttle.blockIp(IP, { hours: 24, now })
      now = last.blocked_until + 1
    }
    expect(last.strikes).toBe(10)
    expect(throttle.blockIp(IP, { hours: 24, now }).blocked_until - now).toBe(MAX_BLOCK_MS)

    // Осознанный ручной бан длиннее потолка автоматики не урезается,
    // а короткая блокировка поверх длинной не сокращает наказание.
    const long = throttle.blockIp(IP, { hours: 24 * 60, reason: 'manual', now })
    expect(long.blocked_until - now).toBe(60 * 24 * HOUR)
    const short = throttle.blockIp(IP, { hours: 1, reason: 'manual', now })
    expect(short.blocked_until).toBe(long.blocked_until)
  })

  it('не удваивает срок, пока действующая блокировка ещё не истекла', () => {
    const { throttle } = setup()

    failTimes(throttle, 20)
    const before = throttle.listBlocks({ now: BASE })[0]

    // Сканер продолжает стучаться — попытки пишутся, но наказание не растёт.
    const again = failTimes(throttle, 10, { from: BASE + MINUTE })
    expect(again).toMatchObject({ blocked: true, reason: 'ip_blocked' })

    const after = throttle.listBlocks({ now: BASE })[0]
    expect(after.strikes).toBe(before.strikes)
    expect(after.blocked_until).toBe(before.blocked_until)
  })

  it('ловит перебор списка логинов раньше, чем накопятся неудачи', () => {
    const { throttle } = setup()

    const users = ['ivan', 'petr', 'maria', 'olga', 'sergey']
    for (let i = 0; i < STUFFING_MAX_USERS - 1; i += 1) {
      const step = throttle.registerFailure({ ipHash: IP, username: users[i], now: BASE + i })
      expect(step.blocked).toBe(false)
    }
    expect(throttle.detectStuffing(IP, { now: BASE })).toMatchObject({
      detected: false,
      usernames: 4,
    })

    const fifth = throttle.registerFailure({
      ipHash: IP,
      username: users[4],
      now: BASE + 4,
    })
    // Всего пять неудач — до порогов 10 и 20 далеко, но пять разных логинов
    // с одного адреса это перебор чужой утёкшей базы.
    expect(fifth).toMatchObject({ blocked: true, reason: 'credential_stuffing', fails: 5 })
    expect(fifth.until).toBe(BASE + 4 + 24 * HOUR)
    expect(throttle.listBlocks({ now: BASE })[0]).toMatchObject({ strikes: 1, active: true })
  })

  it('регистр логина не считается разными пользователями', () => {
    const { throttle } = setup()

    for (const name of ['admin', 'Admin', 'ADMIN', 'aDmIn', 'admiN']) {
      throttle.recordAttempt({ ipHash: IP, username: name, outcome: 'bad_password', now: BASE })
    }
    expect(throttle.detectStuffing(IP, { now: BASE })).toMatchObject({
      detected: false,
      usernames: 1,
    })
  })

  it('перебор в разных часах не складывается', () => {
    const { throttle } = setup()

    const users = ['ivan', 'petr', 'maria', 'olga', 'sergey']
    users.slice(0, 3).forEach((name, i) => {
      throttle.recordAttempt({ ipHash: IP, username: name, outcome: 'unknown_user', now: BASE + i })
    })
    // Прошло два часа — первая тройка вне окна детектора.
    users.slice(3).forEach((name, i) => {
      throttle.recordAttempt({
        ipHash: IP,
        username: name,
        outcome: 'unknown_user',
        now: BASE + 2 * HOUR + i,
      })
    })
    expect(throttle.detectStuffing(IP, { now: BASE + 2 * HOUR + 10 })).toMatchObject({
      detected: false,
      usernames: 2,
    })
  })

  it('успешный вход обнуляет счётчики учётки и задержку адреса', () => {
    const { db, throttle } = setup()
    addUser(db, 'admin')

    failTimes(throttle, 5)
    expect(throttle.checkIp(IP, { now: BASE + MINUTE }).delayMs).toBe(1_000)

    // Регистр другой: users.username объявлен COLLATE NOCASE, это та же учётка.
    expect(throttle.registerSuccess({ ipHash: IP, username: 'ADMIN', now: BASE + MINUTE }))
      .toEqual({ reset: 1 })
    expect(readUser(db, 'admin')).toMatchObject({
      failed_attempts: 0,
      lock_level: 0,
      locked_until: null,
    })

    // Задержка считается от последнего успеха, поэтому прошлые опечатки
    // больше не тормозят живого человека.
    expect(throttle.checkIp(IP, { now: BASE + MINUTE + 1 }).delayMs).toBe(0)
    expect(throttle.registerFailure({ ipHash: IP, username: 'admin', now: BASE + 2 * MINUTE }))
      .toMatchObject({ delayMs: 0 })
  })

  it('успех не сбрасывает счётчик эскалации и не снимает блокировку', () => {
    const { db, throttle } = setup()
    addUser(db, 'admin')

    failTimes(throttle, 19)
    throttle.registerSuccess({ ipHash: IP, username: 'admin', now: BASE + 20 * 1_000 })

    // Одна настоящая учётка не должна работать кнопкой «сбросить антибрут».
    const twentieth = failTimes(throttle, 1, { from: BASE + 30 * 1_000 })
    expect(twentieth).toMatchObject({ blocked: true, reason: 'ip_blocked' })

    throttle.registerSuccess({ ipHash: IP, username: 'admin', now: BASE + 40 * 1_000 })
    expect(throttle.checkIp(IP, { now: BASE + 41 * 1_000 }).blocked).toBe(true)
  })

  it('unblockIp снимает блокировку вместе со strikes', () => {
    const { throttle } = setup()

    throttle.blockIp(IP, { hours: 24, now: BASE })
    throttle.blockIp(OTHER_IP, { hours: 1, reason: 'manual', now: BASE })

    expect(throttle.unblockIp(IP)).toBe(1)
    expect(throttle.unblockIp(IP)).toBe(0)
    expect(throttle.checkIp(IP, { now: BASE }).blocked).toBe(false)

    const list = throttle.listBlocks({ now: BASE })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ ip_hash: OTHER_IP, reason: 'manual' })

    // Заведённая заново блокировка начинается с первой ступени.
    expect(throttle.blockIp(IP, { hours: 24, now: BASE }).strikes).toBe(1)
  })

  it('отвергает мусорные аргументы блокировки', () => {
    const { throttle } = setup()

    expect(() => throttle.blockIp(IP, { hours: 0 })).toThrow(TypeError)
    expect(() => throttle.blockIp(IP, { hours: Infinity })).toThrow(TypeError)
    expect(() => throttle.blockIp(IP, { reason: 'because' })).toThrow(TypeError)
    expect(() => throttle.blockIp('127.0.0.1')).toThrow(TypeError)
  })

  it('обращение к ловушке блокирует сразу, без накопления', () => {
    const { throttle } = setup()

    const block = throttle.registerHoneypot({ ipHash: IP, now: BASE })
    expect(block).toMatchObject({ strikes: 1, reason: 'rate_limit' })
    expect(block.blocked_until).toBe(BASE + 24 * HOUR)
    expect(throttle.checkIp(IP, { now: BASE + HOUR })).toMatchObject({
      blocked: true,
      reason: 'rate_limit',
    })
  })

  it('gcThrottle убирает старые попытки и отлежавшие блокировки', () => {
    const { db, throttle } = setup()

    throttle.recordAttempt({ ipHash: IP, username: 'admin', now: BASE })
    throttle.recordAttempt({ ipHash: IP, username: 'admin', now: BASE + 40 * 24 * HOUR })
    throttle.blockIp(IP, { hours: 24, now: BASE })
    throttle.blockIp(OTHER_IP, { hours: 24, now: BASE + 40 * 24 * HOUR })

    // Через 41 день после BASE: первая попытка и первая блокировка отлежали
    // ретеншн, вторая пара — свежая.
    const now = BASE + 41 * 24 * HOUR
    expect(throttle.gcThrottle(now)).toEqual({ attempts: 1, blocks: 1 })

    expect(db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n).toBe(1)
    expect(throttle.listBlocks().map((row) => row.ip_hash)).toEqual([OTHER_IP])

    // Повторный вызов ничего не находит.
    expect(throttle.gcThrottle(now)).toEqual({ attempts: 0, blocks: 0 })
  })

  it('gcThrottle не трогает истёкшую блокировку, пока она помнит strikes', () => {
    const { throttle } = setup()

    throttle.blockIp(IP, { hours: 24, now: BASE })
    // Блокировка уже не действует, но строка нужна: вернувшийся сканер обязан
    // получить удвоенный срок, а не «первую» блокировку заново.
    expect(throttle.gcThrottle(BASE + 2 * 24 * HOUR).blocks).toBe(0)
    expect(throttle.blockIp(IP, { hours: 24, now: BASE + 2 * 24 * HOUR }).strikes).toBe(2)
  })
})

describe('isHoneypot', () => {
  it('узнаёт пути, по которым ходят только сканеры', () => {
    for (const path of HONEYPOT_PATHS) {
      expect(isHoneypot(path)).toBe(true)
    }
  })

  it('ловит вложенные пути и хвостовой слэш', () => {
    expect(isHoneypot('/wp-admin/')).toBe(true)
    expect(isHoneypot('/wp-admin/setup-config.php')).toBe(true)
    expect(isHoneypot('/vendor/phpunit/phpunit/phpunit.php')).toBe(true)
    expect(isHoneypot('/.git/config')).toBe(true)
  })

  it('не обманывается регистром, кодированием и двойными слэшами', () => {
    expect(isHoneypot('/WP-Login.php')).toBe(true)
    expect(isHoneypot('/%2Eenv')).toBe(true)
    expect(isHoneypot('//.env')).toBe(true)
    expect(isHoneypot('/.env?format=json')).toBe(true)
    expect(isHoneypot('/.env#fragment')).toBe(true)
  })

  it('не задевает настоящие маршруты сайта', () => {
    const real = ['/', '/api/lead', '/locales/ru.json', '/media/photo.webp', '/projects/mall']
    for (const path of real) {
      expect(isHoneypot(path)).toBe(false)
    }
    // Похожие, но не те: ловушка не должна ловить по подстроке.
    expect(isHoneypot('/environment')).toBe(false)
    expect(isHoneypot('/wp-login.php.bak')).toBe(false)
    expect(isHoneypot('/vendor/phpunitilities')).toBe(false)
  })

  it('переживает мусор на входе', () => {
    expect(isHoneypot('')).toBe(false)
    expect(isHoneypot(null)).toBe(false)
    expect(isHoneypot(undefined)).toBe(false)
    expect(isHoneypot(42)).toBe(false)
    // Битая процентная последовательность не должна ронять обработчик:
    // такой путь сравнивается как есть и просто не совпадает ни с чем.
    expect(isHoneypot('/%zz')).toBe(false)
    expect(isHoneypot('/%zz/.env')).toBe(false)
  })
})
