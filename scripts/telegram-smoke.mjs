// Сквозная проверка приёма заявки: HTTP → валидация → SQLite → Telegram.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ ПРОВЕРОК. production-smoke.mjs поднимает
// приложение и стучится в публичные маршруты, но заявку не отправляет:
// в проде TELEGRAM_API_BASE запрещён конфигом, а ходить в настоящий Bot API
// из теста нельзя. Юнит-тесты конвейера подменяют доставку заглушкой,
// поэтому мимо них проходит всё, что ломается на стыке: формат сообщения,
// подстановка плейсхолдеров, запись колонок, статусы доставки.
//
// Здесь поднимается НАСТОЯЩЕЕ приложение (app.cjs) и настоящая заглушка
// Bot API (scripts/mock-telegram.mjs), между ними идёт живой HTTP, а результат
// сверяется и по ответу API, и по строке в базе, и по тому, что реально
// получил «Telegram».
//
// Режим development — единственно возможный: assertProductionConfig()
// отказывается стартовать с TELEGRAM_API_BASE, и это правильно (заглушка
// в проде означала бы потерянные заявки). Проверяемая цепочка от режима
// не зависит: маршрут, конвейер, репозиторий и шлюз — те же самые.
//
// Данные строго тестовые (см. CLAUDE.md): настоящие имена и телефоны
// в этот скрипт не попадают никогда.

import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STARTUP_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const availablePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })

const dataDir = mkdtempSync(join(tmpdir(), 'prohvac-telegram-smoke-'))
const appPort = await availablePort()
const mockPort = await availablePort()
const mockLog = join(dataDir, 'mock-telegram.log')
const origin = `http://127.0.0.1:${appPort}`

const failures = []
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  failures.push(name)
}

const children = []
const stop = () => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
}

process.on('exit', () => {
  stop()
  rmSync(dataDir, { recursive: true, force: true })
})

const spawnChild = (args, env = {}) => {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.log = ''
  child.stdout.on('data', (chunk) => (child.log += chunk.toString()))
  child.stderr.on('data', (chunk) => (child.log += chunk.toString()))
  children.push(child)
  return child
}

console.log('Telegram smoke: приём заявки от HTTP до сообщения в чате\n')

const mock = spawnChild(['scripts/mock-telegram.mjs', String(mockPort)], {
  MOCK_TELEGRAM_LOG: mockLog,
})

const app = spawnChild(['app.cjs'], {
  NODE_ENV: 'development',
  PORT: String(appPort),
  DATA_DIR: dataDir,
  PUBLIC_ORIGIN: origin,
  ALLOWED_ORIGINS: origin,
  TRUSTED_HOSTS: '127.0.0.1',
  APP_SECRET: randomBytes(32).toString('hex'),
  GATE_SECRET: randomBytes(32).toString('hex'),
  ADMIN_SECRET_PATH: randomBytes(16).toString('hex'),
  ADMIN_REQUIRE_GATE: '0',
  // Формат токена важен: конфиг и настройки проверяют его по образцу
  // «<id бота>:<хвост>», и подставная строка вида 'test' до доставки не дойдёт.
  TELEGRAM_BOT_TOKEN: `${Math.floor(Math.random() * 9e8) + 1e8}:${randomBytes(24).toString('base64url')}`,
  TELEGRAM_CHAT_ID: '-1000000000000',
  TELEGRAM_API_BASE: `http://127.0.0.1:${mockPort}`,
})

const deadline = Date.now() + STARTUP_TIMEOUT_MS
let ready = false
while (Date.now() < deadline) {
  await wait(250)
  if (app.exitCode !== null) break
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1_500) })
    if (response.status) {
      ready = true
      break
    }
  } catch {
    // Ещё не слушает — пробуем снова.
  }
}

if (!ready) {
  console.error('приложение не поднялось:\n' + app.log.slice(-4_000))
  process.exit(1)
}

// Дождаться, пока заглушка начнёт ПРИНИМАТЬ соединения, а не пока она
// напечатает «слушаю». Это разные моменты: на Windows первое подключение
// к только что занятому порту loopback отваливается по ETIMEDOUT уже после
// успешного listen, и повтор проходит сразу.
//
// Без этой проверки первая же заявка уходила в мёртвое соединение, шлюз
// (правильно) считал такой сбой неопределённым, заявка получала
// delivery_unknown — и скрипт падал на семи проверках подряд, обвиняя
// приложение в том, что сломано было в его собственном стенде. Повторять
// саму заявку нельзя: delivery_unknown без подтверждения оператора не
// переотправляется — это как раз то поведение, которое здесь проверяется.
//
// Пинг идёт не в /sendMessage: заглушка ответит на него 404 и не запишет
// лишнюю строку в лог сообщений, по которому потом ведётся счёт.
const mockDeadline = Date.now() + STARTUP_TIMEOUT_MS
let mockReady = false
while (Date.now() < mockDeadline) {
  if (mock.exitCode !== null) break
  try {
    await fetch(`http://127.0.0.1:${mockPort}/ping`, { signal: AbortSignal.timeout(1_500) })
    mockReady = true
    break
  } catch {
    await wait(250)
  }
}

if (!mockReady) {
  console.error('заглушка Telegram не поднялась:\n' + mock.log.slice(-4_000))
  process.exit(1)
}

const post = (body, headers = {}) =>
  fetch(`${origin}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

const lead = {
  name: 'Тест Тестов',
  phone: '+998 90 000 00 00',
  message: 'Тестовая заявка, игнорировать',
  locale: 'uz',
  pagePath: '/',
  attribution: {
    utmSource: 'yandex',
    utmMedium: 'cpc',
    utmCampaign: 'hvac-tashkent',
    yclid: '123456789',
    ymClientId: '1712345678901234567',
    referrer: 'https://yandex.uz/search/',
    unknownField: 'должно быть отброшено',
  },
}

console.log('доставка')
const accepted = await post(lead)
const acceptedBody = await accepted.json().catch(() => null)
check('заявка принята (200)', accepted.status === 200, `статус ${accepted.status}`)
check('состояние доставки sent', acceptedBody?.deliveryState === 'sent', JSON.stringify(acceptedBody))

await wait(500)
const messages = existsSync(mockLog)
  ? readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []
check('Telegram получил ровно одно сообщение', messages.length === 1, `получено ${messages.length}`)

const text = messages[0]?.text || ''
check('в сообщении есть имя', text.includes('Тест Тестов'))
check('телефон нормализован и экранирован', text.includes('\\+998900000000'))
check('parse_mode MarkdownV2', messages[0]?.parse_mode === 'MarkdownV2')
// Регрессия: {lang} заполнялся значением по умолчанию, потому что в сообщение
// уходил только name/phone/message. В базе язык был верный, в чате — всегда ru.
check('язык заявки попал в сообщение', text.trimEnd().endsWith('· uz'), text.slice(-40))

console.log('\nидемпотентность')
const key = randomUUID()
const firstWithKey = await post(lead, { 'Idempotency-Key': key })
const repeat = await post(lead, { 'Idempotency-Key': key })
const repeatBody = await repeat.json().catch(() => null)
check('повтор с тем же ключом принят', repeat.status === 200, `статус ${repeat.status}`)
check('повтор помечен как duplicate', repeatBody?.duplicate === true, JSON.stringify(repeatBody))
check('первая отправка с ключом прошла', firstWithKey.status === 200)

const conflict = await post({ ...lead, name: 'Другое Имя' }, { 'Idempotency-Key': key })
check('чужая заявка с занятым ключом отклонена (409)', conflict.status === 409, `статус ${conflict.status}`)

console.log('\nграницы')
const invalid = await post({ name: 'X', phone: '123', message: '' })
check('негодная заявка отклонена (400)', invalid.status === 400, `статус ${invalid.status}`)
const foreign = await post(lead, { Origin: 'https://evil.example' })
check('чужой Origin отклонён', foreign.status === 403, `статус ${foreign.status}`)

console.log('\nзапись в базе')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(dataDir, 'app.sqlite'), { readOnly: true })
const rows = db
  .prepare(
    `SELECT locale, telegram_status, delivery_state, status,
            utm_source, utm_medium, utm_campaign, utm_content,
            yclid, gclid, ym_client_id, referrer
       FROM leads ORDER BY id`
  )
  .all()
db.close()

check('заявок в базе две (повтор не создал третью)', rows.length === 2, `строк ${rows.length}`)
const row = rows[0] || {}
check('статус доставки в базе sent', row.telegram_status === 'sent' && row.delivery_state === 'sent')
check('язык сохранён', row.locale === 'uz', String(row.locale))
check('utm сохранены', row.utm_source === 'yandex' && row.utm_medium === 'cpc')
check('yclid и ClientID сохранены', row.yclid === '123456789' && row.ym_client_id === '1712345678901234567')
check('пустые метки остались пустыми', row.utm_content === null && row.gclid === null)
check('referrer сохранён', row.referrer === 'https://yandex.uz/search/')

stop()
await wait(500)

console.log('')
if (failures.length) {
  console.error(`Telegram smoke: провалено ${failures.length} — ${failures.join(', ')}`)
  process.exit(1)
}
console.log('Telegram smoke: цепочка заявки работает целиком')
