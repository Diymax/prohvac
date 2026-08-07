import { describe, expect, it } from 'vitest'

import {
  TELEGRAM_TEXT_LIMIT,
  findMarkdownV2Error,
  isValidMarkdownV2,
  stripMarkdownV2,
} from './telegram-markdown.js'

describe('findMarkdownV2Error', () => {
  it.each([
    ['обычный текст без разметки', 'Заявка принята'],
    ['жирный', '*жирный*'],
    ['курсив', '_курсив_'],
    ['подчёркнутый двойным подчёркиванием', '__подчёркнутый__'],
    ['зачёркнутый', '~зачёркнутый~'],
    ['спойлер', '||секрет||'],
    ['экранированная точка', 'конец\\.'],
    ['экранированный дефис в дате', '2026\\-01\\-01'],
    ['код со служебными символами внутри', '`a.b-c!`'],
    ['блок кода', '```\nlet x = 1.0\n```'],
    ['ссылка', '[текст](https://example.invalid/a)'],
    ['разметка внутри подписи ссылки', '[*жирный*](https://example.invalid)'],
    ['эмодзи рядом с экранированием', '🕒 2026\\-01\\-01 15:40 · ru'],
    ['пустая строка', ''],
  ])('принимает %s', (_name, text) => {
    expect(findMarkdownV2Error(text)).toBeNull()
    expect(isValidMarkdownV2(text)).toBe(true)
  })

  // Каждый случай — реальная причина, по которой Telegram отвечает 400
  // «can't parse entities» и заявка не доходит совсем.
  it.each([
    ['неэкранированная точка', 'конец.', '.'],
    ['неэкранированный дефис', 'а - б', '-'],
    ['восклицательный знак', 'Ура!', '!'],
    ['скобка', 'текст (сайт)', '('],
    ['плюс в телефоне', '+998900000000', '+'],
  ])('отвергает %s', (_name, text, char) => {
    const error = findMarkdownV2Error(text)
    expect(error).not.toBeNull()
    expect(error.char).toBe(char)
    expect(typeof error.reason).toBe('string')
  })

  it('отвергает незакрытое выделение', () => {
    expect(findMarkdownV2Error('*жирный')?.reason).toMatch(/не закрыто/)
  })

  it('отвергает незакрытый код', () => {
    expect(findMarkdownV2Error('`код')?.reason).toMatch(/не закрыт/)
  })

  it('отвергает незакрытый блок кода', () => {
    expect(findMarkdownV2Error('```\nкод')?.reason).toMatch(/не закрыт блок/)
  })

  it('отвергает ссылку без адреса', () => {
    expect(findMarkdownV2Error('[текст]')?.reason).toMatch(/\(url\)/)
  })

  it('отвергает экранирование неслужебного символа', () => {
    expect(findMarkdownV2Error('а\\z')?.reason).toMatch(/служебные/)
  })

  it('отвергает одиночный обратный слэш в конце', () => {
    expect(findMarkdownV2Error('текст\\')?.reason).toMatch(/одиночным/)
  })

  it('сообщает позицию ошибки', () => {
    expect(findMarkdownV2Error('абв.')?.offset).toBe(3)
  })

  it('не считает служебным символ внутри блока кода', () => {
    expect(findMarkdownV2Error('```\n1.0 - 2\n```')).toBeNull()
  })
})

describe('stripMarkdownV2', () => {
  it('снимает разметку и раскрывает экранирование', () => {
    expect(stripMarkdownV2('*Имя:* Тест\\-Тестов')).toBe('Имя: Тест-Тестов')
  })

  it('оставляет текст без разметки как есть', () => {
    expect(stripMarkdownV2('просто текст')).toBe('просто текст')
  })

  it('снимает код и спойлер', () => {
    expect(stripMarkdownV2('`код` и ||секрет||')).toBe('код и секрет')
  })

  it('переживает пустое значение', () => {
    expect(stripMarkdownV2(null)).toBe('')
  })
})

describe('TELEGRAM_TEXT_LIMIT', () => {
  it('совпадает с пределом Bot API', () => {
    expect(TELEGRAM_TEXT_LIMIT).toBe(4096)
  })
})
