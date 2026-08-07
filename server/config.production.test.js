// Проверки, без которых нельзя стартовать в production.
//
// ПОЧЕМУ ЧЕРЕЗ ДОЧЕРНИЙ ПРОЦЕСС. server/config.js читает окружение и валидирует
// его при импорте, а модуль в процессе один: подменить переменные между
// проверками внутри одного прогона нельзя — первый импорт зафиксирует значения
// для всех последующих. Тот же приём применяет scripts/prepare-production.mjs.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

const dataDir = mkdtempSync(join(tmpdir(), 'prohvac-config-'))

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

// Заведомо синтетические значения нужной формы. Маркер обязателен: строка
// подходит под шаблон боевого секрета из scripts/secret-patterns.mjs.
const VALID = Object.freeze({
  NODE_ENV: 'production',
  APP_SECRET: `NOT-A-REAL-SECRET-${'a'.repeat(40)}`,
  GATE_SECRET: `NOT-A-REAL-SECRET-${'b'.repeat(40)}`,
  ADMIN_SECRET_PATH: 'abcdefghijklmnopqrstuvwxyz',
  PUBLIC_ORIGIN: 'https://www.prohvac.uz',
  TELEGRAM_BOT_TOKEN: '123456789:NOT-A-REAL-TOKEN-aaaaaaaaaaaaaaaa',
  TELEGRAM_CHAT_ID: '-1001234567890',
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
})

/**
 * Прогоняет assertProductionConfig() в отдельном процессе.
 *
 * @param {Record<string, string|undefined>} overrides
 * @returns {{ok: boolean, output: string}}
 */
const check = (overrides = {}) => {
  const env = { ...process.env, DATA_DIR: dataDir, ...VALID, ...overrides }

  // Окружение теста обязано быть герметичным. vite.config.js подхватывает
  // .env.local и раскладывает его значения в process.env, поэтому дочерний
  // процесс без явной очистки унаследовал бы TELEGRAM_API_BASE от локальной
  // заглушки — и «корректная конфигурация» падала бы на машине разработчика,
  // но не в CI.
  if (!('TELEGRAM_API_BASE' in overrides)) delete env.TELEGRAM_API_BASE

  // undefined означает «переменной нет», а не «пустая строка».
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value === undefined) delete env[key]
  }

  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import('./server/config.js'); m.assertProductionConfig(); console.log('OK')`,
    ],
    { cwd: process.cwd(), env, encoding: 'utf8' }
  )

  return { ok: probe.status === 0, output: `${probe.stdout || ''}${probe.stderr || ''}` }
}

describe('assertProductionConfig', () => {
  it('принимает полную корректную конфигурацию', () => {
    const result = check()
    expect(result.ok, result.output).toBe(true)
  })

  // За обратным прокси пустой список делает ipHash одинаковым у всех:
  // лимит частоты становится общим на сайт, а одна сработавшая ловушка
  // блокирует всех разом на сутки.
  it('не стартует без TRUSTED_PROXY_CIDRS', () => {
    const result = check({ TRUSTED_PROXY_CIDRS: undefined })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('TRUSTED_PROXY_CIDRS')
  })

  it('принимает явно заявленное прямое подключение', () => {
    const result = check({ TRUSTED_PROXY_CIDRS: 'none' })
    expect(result.ok, result.output).toBe(true)
  })

  it.each([
    ['обрезанный', '123456789:short'],
    ['без двоеточия', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['подставленный chat_id', '-1001234567890'],
  ])('не стартует с токеном бота вида «%s»', (_name, token) => {
    const result = check({ TELEGRAM_BOT_TOKEN: token })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('TELEGRAM_BOT_TOKEN')
  })

  // База лежит рядом с заявками и хешами паролей: внутри каталога сайта она
  // скачивается по прямой ссылке.
  it.each([
    ['httpdocs', ['httpdocs', 'data']],
    ['public_html', ['public_html', 'data']],
    ['www/html', ['www', 'html', 'data']],
  ])('не стартует с DATA_DIR внутри каталога сайта (%s)', (_name, parts) => {
    const result = check({ DATA_DIR: join(dataDir, ...parts) })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('DATA_DIR')
  })

  // Раскладка Plesk: /var/www/vhosts/<домен>/<каталог>. Голая проверка на
  // сегмент «www» отвергала её, и приложение не стартовало на совершенно
  // правильном пути — это ловилось только на боевом сервере.
  it('принимает путь подписки Plesk с /var/www/ в середине', () => {
    const result = check({ DATA_DIR: join(dataDir, 'var', 'www', 'vhosts', 'site.uz', 'app', 'data') })
    expect(result.ok, result.output).toBe(true)
  })

  // Заглушка в проде означала бы заявки, которые никуда не уходят при
  // полностью зелёном интерфейсе.
  it('не стартует с подменённым адресом Bot API', () => {
    const result = check({ TELEGRAM_API_BASE: 'http://127.0.0.1:8788' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('TELEGRAM_API_BASE')
  })
})
