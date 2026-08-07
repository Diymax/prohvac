// Единая команда локального запуска: `npm start`.
//
// ЗАЧЕМ. Раньше запуск состоял из двух терминалов и одного молчаливого
// условия: сначала `npm run mock:telegram`, потом `npm run dev`, и только
// если TELEGRAM_API_BASE в .env.local указывает на заглушку. Забыть первый
// шаг было легко, а расплата несоразмерная: dev-сервер поднимает ПРОДОВЫЙ
// роутер (см. CLAUDE.md), поэтому тестовая заявка уходит в реальный чат
// отдела продаж. Здесь оба процесса поднимаются вместе и, что важнее,
// перед стартом проверяется, куда именно уйдёт заявка.
//
// Скрипт владеет обоими процессами: падение любого из них останавливает
// второй, Ctrl+C гасит оба. Иначе заглушка остаётся висеть на порту
// и следующий запуск молча берёт чужой процесс.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const MOCK_PORT = Number(process.env.MOCK_TELEGRAM_PORT || 8788)
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`

/**
 * Читает .env.local ровно настолько, насколько нужно для проверки адреса
 * Bot API. Полноценный парсер переменных здесь не нужен и вреден: значения
 * в процесс не попадают, их читает сам dev-сервер через Vite.
 */
const readEnvLocal = () => {
  if (!existsSync('.env.local')) return {}
  const values = {}
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return values
}

const env = readEnvLocal()
const apiBase = process.env.TELEGRAM_API_BASE || env.TELEGRAM_API_BASE || ''

// Единственная проверка, ради которой стоит падать до старта: пустой или
// боевой TELEGRAM_API_BASE означает, что первая же тестовая заявка попадёт
// в рабочий чат. Отказ здесь дешевле извинений в чате.
if (!apiBase) {
  console.error(
    '\nTELEGRAM_API_BASE не задан.\n' +
      'Локальные заявки ушли бы в НАСТОЯЩИЙ чат отдела продаж.\n' +
      `Добавьте в .env.local:  TELEGRAM_API_BASE=${MOCK_BASE}\n` +
      'Либо запустите с явным адресом: TELEGRAM_API_BASE=<адрес> npm start\n'
  )
  process.exit(1)
}

const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(apiBase)
if (!local) {
  console.error(
    `\nTELEGRAM_API_BASE=${apiBase} указывает не на локальную заглушку.\n` +
      'Тестовые заявки уйдут по этому адресу. Если это осознанно, запускайте\n' +
      'dev-сервер напрямую: npm run dev\n'
  )
  process.exit(1)
}

const children = []
let stopping = false

const stopAll = (code) => {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
  // Небольшая пауза, чтобы Vite успел закрыть сокет и освободить порт.
  setTimeout(() => process.exit(code), 300)
}

const start = (label, args) => {
  const child = spawn('node', args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    if (stopping) return
    console.error(`\n[${label}] завершился (код ${code ?? signal}) — останавливаю остальное.`)
    stopAll(code ?? 1)
  })
  children.push(child)
  return child
}

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))

console.log(`заглушка Telegram: ${MOCK_BASE} (заявки в рабочий чат не уходят)`)
start('mock:telegram', ['scripts/mock-telegram.mjs', String(MOCK_PORT)])

// Vite запускается своим бинарником, а не через npm run: лишний слой npm
// перехватывает сигналы и оставляет dev-сервер живым после Ctrl+C.
start('dev', ['node_modules/vite/bin/vite.js'])
