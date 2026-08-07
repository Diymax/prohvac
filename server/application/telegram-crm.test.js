import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { applyTelegramUpdate, callbackSecretFor, webhookSecretFor } from './telegram-crm.js'
import { encodeCallbackData } from '../domain/lead-crm.js'
import { findMarkdownV2Error } from '../../shared/telegram-markdown.js'

const CHAT_ID = '-1001234567890'

const telegram = {
  botToken: 'fixture-token',
  chatId: CHAT_ID,
  apiBase: 'https://telegram.invalid',
  template: '📩 *Заявка*\n👤 *Имя:* {name}\n📞 *Телефон:* {phone}',
  enabled: true,
}

const secret = callbackSecretFor('fixture-app-secret')

describe('applyTelegramUpdate', () => {
  let db
  let gateway
  let calls

  const insertLead = (status = 'new') => {
    const info = db.run(
      `INSERT INTO leads (created_at, name, phone, message, locale, ip_hash, status, purge_after)
       VALUES (?, 'Тест Тестов', '+998900000000', '', 'ru', ?, ?, ?)`,
      [Date.now(), 'a'.repeat(64), status, Date.now() + 86_400_000]
    )
    return Number(info.lastInsertRowid)
  }

  const updateFor = (leadId, status, overrides = {}) => ({
    update_id: overrides.updateId ?? 1,
    callback_query: {
      id: 'cbq-1',
      from: { id: 555, username: 'manager' },
      message: {
        message_id: 900,
        chat: { id: overrides.chatId ?? Number(CHAT_ID) },
      },
      data: overrides.data ?? encodeCallbackData({ secret, leadId, status }),
    },
  })

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)

    calls = []
    const record = (method) => async (payload) => {
      calls.push({ method, payload })
      return { ok: true, definitive: true, responseCode: 200, result: {} }
    }
    gateway = {
      answerCallbackQuery: vi.fn(record('answerCallbackQuery')),
      editMessageText: vi.fn(record('editMessageText')),
      editMessageReplyMarkup: vi.fn(record('editMessageReplyMarkup')),
    }
  })

  afterEach(() => db.close())

  const run = (update, extra = {}) =>
    applyTelegramUpdate({ db, gateway, telegram, callbackSecret: secret, update, ...extra })

  it('меняет статус заявки и записывает источник', async () => {
    const leadId = insertLead('new')
    const result = await run(updateFor(leadId, 'in_progress'))

    expect(result).toMatchObject({ handled: true, leadId, status: 'in_progress', changed: true })
    expect(db.get('SELECT status, status_source, status_actor FROM leads WHERE id = ?', [leadId])).toMatchObject({
      status: 'in_progress',
      status_source: 'telegram',
      status_actor: '@manager',
    })
  })

  // Без ответа кнопка в клиенте крутится до таймаута, и менеджер жмёт её снова.
  it('всегда отвечает на нажатие', async () => {
    const leadId = insertLead('new')
    await run(updateFor(leadId, 'done'))
    expect(gateway.answerCallbackQuery).toHaveBeenCalledTimes(1)
  })

  it('перерисовывает карточку валидной разметкой MarkdownV2', async () => {
    const leadId = insertLead('new')
    await run(updateFor(leadId, 'done'))

    const edit = calls.find((call) => call.method === 'editMessageText')
    expect(edit).toBeTruthy()
    expect(edit.payload.parse_mode).toBe('MarkdownV2')
    expect(findMarkdownV2Error(edit.payload.text)).toBeNull()
    expect(edit.payload.reply_markup.inline_keyboard.flat()).toHaveLength(4)
  })

  // Telegram повторяет обновление, пока не получит 200.
  it('обрабатывает одно и то же обновление ровно один раз', async () => {
    const leadId = insertLead('new')
    await run(updateFor(leadId, 'done', { updateId: 77 }))
    const second = await run(updateFor(leadId, 'spam', { updateId: 77 }))

    expect(second).toMatchObject({ handled: false, reason: 'duplicate_update' })
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('done')
  })

  it('отвергает подпись от чужого секрета, не трогая заявку', async () => {
    const leadId = insertLead('new')
    const foreign = encodeCallbackData({ secret: 'чужой-секрет', leadId, status: 'spam' })
    const result = await run(updateFor(leadId, 'spam', { data: foreign }))

    expect(result).toMatchObject({ handled: false, reason: 'bad_signature' })
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('new')
    expect(gateway.answerCallbackQuery).toHaveBeenCalledTimes(1)
  })

  // Бота могли добавить в посторонний чат: карточки там нашими не становятся.
  it('игнорирует нажатие из чужого чата', async () => {
    const leadId = insertLead('new')
    const result = await run(updateFor(leadId, 'spam', { chatId: -100999, updateId: 5 }))

    expect(result).toMatchObject({ handled: false, reason: 'foreign_chat' })
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('new')
  })

  // Срок хранения ПДн наступает сам, а сообщение в чате живёт вечно.
  it('снимает кнопки, когда заявка уже удалена', async () => {
    const result = await run(updateFor(999_999, 'done'))

    expect(result).toMatchObject({ handled: false, reason: 'lead_not_found' })
    expect(gateway.editMessageReplyMarkup).toHaveBeenCalledTimes(1)
    expect(calls.at(-1).payload.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('сообщает, что статус уже стоит, и не перерисовывает карточку', async () => {
    const leadId = insertLead('done')
    const result = await run(updateFor(leadId, 'done'))

    expect(result).toMatchObject({ handled: true, changed: false })
    expect(gateway.editMessageText).not.toHaveBeenCalled()
  })

  it('пропускает обновление, которое не является нажатием кнопки', async () => {
    const result = await run({ update_id: 3, message: { text: 'привет' } })
    expect(result).toMatchObject({ handled: false, reason: 'not_a_callback' })
  })

  it('пишет в журнал без персональных данных заявки', async () => {
    const leadId = insertLead('new')
    const entries = []
    await run(updateFor(leadId, 'done'), { audit: (entry) => entries.push(entry) })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'lead.status_telegram', entityId: leadId })
    const serialized = JSON.stringify(entries[0])
    expect(serialized).not.toContain('Тест Тестов')
    expect(serialized).not.toContain('998900000000')
  })

  // Неудачная перерисовка не должна отменять уже сохранённый статус.
  it('сохраняет статус, даже если карточку обновить не удалось', async () => {
    const leadId = insertLead('new')
    gateway.editMessageText = vi.fn(async () => ({ ok: false, error: 'telegram_failed' }))

    const result = await run(updateFor(leadId, 'spam'))
    expect(result).toMatchObject({ handled: true, changed: true })
    expect(db.get('SELECT status FROM leads WHERE id = ?', [leadId]).status).toBe('spam')
  })
})

describe('производные секреты', () => {
  it('различают назначения', () => {
    expect(callbackSecretFor('one')).not.toBe(webhookSecretFor('one'))
  })

  it('устойчивы для одного APP_SECRET и меняются вместе с ним', () => {
    expect(callbackSecretFor('one')).toBe(callbackSecretFor('one'))
    expect(callbackSecretFor('one')).not.toBe(callbackSecretFor('two'))
  })

  // Telegram принимает в secret_token только [A-Za-z0-9_-], 1..256 символов.
  it('дают секрет вебхука в допустимом Telegram алфавите', () => {
    const value = webhookSecretFor('fixture-app-secret')
    expect(value).toMatch(/^[A-Za-z0-9_-]{1,256}$/)
  })
})
