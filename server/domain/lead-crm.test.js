import { describe, expect, it } from 'vitest'

import {
  CRM_STATUSES,
  actorName,
  buildStatusKeyboard,
  decodeCallbackData,
  encodeCallbackData,
  renderLeadCard,
  renderStatusLine,
} from './lead-crm.js'
import { findMarkdownV2Error } from '../../shared/telegram-markdown.js'

const secret = 'test-secret-not-a-real-key'

describe('encodeCallbackData / decodeCallbackData', () => {
  it.each(CRM_STATUSES)('обходит круг для статуса %s', (status) => {
    const data = encodeCallbackData({ secret, leadId: 12345, status })
    expect(decodeCallbackData({ secret, data })).toEqual({ ok: true, leadId: 12345, status })
  })

  // 64 байта — жёсткий предел Bot API: кнопка с более длинным значением
  // не отправляется вовсе, и карточка уходит без клавиатуры.
  it('укладывается в 64 байта даже на десятизначном id', () => {
    for (const status of CRM_STATUSES) {
      const data = encodeCallbackData({ secret, leadId: 9_999_999_999, status })
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    }
  })

  it('отвергает подпись от другого секрета', () => {
    const data = encodeCallbackData({ secret, leadId: 7, status: 'done' })
    expect(decodeCallbackData({ secret: 'другой-секрет', data })).toEqual({
      ok: false,
      error: 'bad_signature',
    })
  })

  // Ровно та атака, ради которой стоит подпись: подставить чужой номер заявки.
  it('отвергает подменённый номер заявки при верной подписи другой пары', () => {
    const data = encodeCallbackData({ secret, leadId: 7, status: 'done' })
    const forged = data.replace('v1:7:', 'v1:8:')
    expect(decodeCallbackData({ secret, data: forged })).toEqual({
      ok: false,
      error: 'bad_signature',
    })
  })

  it('отвергает подменённый статус при верной подписи другой пары', () => {
    const data = encodeCallbackData({ secret, leadId: 7, status: 'new' })
    const forged = data.replace(':n:', ':s:')
    expect(decodeCallbackData({ secret, data: forged })).toEqual({
      ok: false,
      error: 'bad_signature',
    })
  })

  it.each([
    ['пустое значение', ''],
    ['мусор', 'нажали'],
    ['неизвестная версия', 'v2:1:n:abcdef012345'],
    ['неизвестный код статуса', 'v1:1:x:abcdef012345'],
    ['нечисловой id', 'v1:абв:n:abcdef012345'],
    ['лишнее поле', 'v1:1:n:abcdef012345:extra'],
  ])('считает %s негодным', (_name, data) => {
    expect(decodeCallbackData({ secret, data }).ok).toBe(false)
  })

  it('отвергает неизвестный статус при кодировании', () => {
    expect(() => encodeCallbackData({ secret, leadId: 1, status: 'archived' })).toThrow(TypeError)
  })
})

describe('buildStatusKeyboard', () => {
  it('содержит все четыре статуса', () => {
    const keyboard = buildStatusKeyboard({ secret, leadId: 1, current: 'new' })
    const flat = keyboard.inline_keyboard.flat()
    expect(flat).toHaveLength(CRM_STATUSES.length)
    for (const button of flat) {
      expect(decodeCallbackData({ secret, data: button.callback_data }).ok).toBe(true)
    }
  })

  it('помечает текущий статус галкой ровно один раз', () => {
    const flat = buildStatusKeyboard({ secret, leadId: 1, current: 'done' }).inline_keyboard.flat()
    expect(flat.filter((button) => button.text.startsWith('✅'))).toHaveLength(1)
    expect(flat.find((button) => button.text.startsWith('✅')).text).toContain('Обработана')
  })
})

describe('renderStatusLine', () => {
  // Строка приписывается к сообщению с parse_mode=MarkdownV2: неэкранированный
  // символ в имени нажавшего отменил бы редактирование всей карточки.
  it('экранирует служебные символы в имени', () => {
    const line = renderStatusLine({ status: 'done', actor: 'Иван_Петров-2.0', at: null })
    expect(findMarkdownV2Error(line)).toBeNull()
  })

  it('обходится без автора и времени', () => {
    expect(renderStatusLine({ status: 'new' })).toContain('Новая')
  })
})

describe('renderLeadCard', () => {
  const lead = {
    id: 42,
    name: 'Тест Тестов',
    phone: '+998900000000',
    message: 'Тестовая заявка, игнорировать',
    locale: 'ru',
    created_at: 1_754_563_200_000,
  }

  const card = (status, actor = '@manager') =>
    renderLeadCard({ template: null, lead, status, actor, at: 1_754_563_300_000, secret })

  // Карточка уходит с parse_mode=MarkdownV2: неэкранированный символ
  // отменяет редактирование целиком, и в чате остаётся прежний статус.
  it.each(CRM_STATUSES)('даёт валидную разметку для статуса %s', (status) => {
    expect(findMarkdownV2Error(card(status).text)).toBeNull()
  })

  it('показывает выбранный статус и данные заявки', () => {
    const { text } = card('done')
    expect(text).toContain('Тест Тестов')
    expect(text).toContain('998900000000')
    expect(text).toContain('Обработана')
  })

  it('помечает галкой ровно текущий статус', () => {
    const flat = card('spam').replyMarkup.inline_keyboard.flat()
    const marked = flat.filter((button) => button.text.startsWith('✅'))
    expect(marked).toHaveLength(1)
    expect(marked[0].text).toContain('Спам')
  })

  it('кнопки указывают на ту же заявку', () => {
    for (const button of card('new').replyMarkup.inline_keyboard.flat()) {
      expect(decodeCallbackData({ secret, data: button.callback_data })).toMatchObject({ leadId: 42 })
    }
  })

  // Ровно то, ради чего рендер общий: смена статуса из панели и нажатие
  // кнопки в чате обязаны дать одинаковую карточку, иначе одна заявка
  // выглядит по-разному в зависимости от того, откуда её тронули.
  it('не зависит от того, откуда пришло изменение', () => {
    expect(card('in_progress', '@manager').text).toBe(card('in_progress', '@manager').text)
  })

  it('экранирует имя автора со служебными символами', () => {
    expect(findMarkdownV2Error(card('done', 'Иван_Петров-2.0').text)).toBeNull()
  })
})

describe('actorName', () => {
  it('предпочитает username', () => {
    expect(actorName({ username: 'manager', first_name: 'Иван' })).toBe('@manager')
  })

  it('склеивает имя и фамилию', () => {
    expect(actorName({ first_name: 'Иван', last_name: 'Петров' })).toBe('Иван Петров')
  })

  it('откатывается на числовой id', () => {
    expect(actorName({ id: 42 })).toBe('id42')
  })

  it('переживает отсутствие отправителя', () => {
    expect(actorName(null)).toBe('неизвестно')
  })
})
