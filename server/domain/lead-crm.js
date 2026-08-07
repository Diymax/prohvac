// Кнопки статуса под карточкой заявки в Telegram.
//
// Чистый домен: ни базы, ни HTTP, ни настроек. Здесь живут только правила
// кодирования callback_data и сборка клавиатуры — то, что обязано совпадать
// у отправителя карточки и у обработчика нажатия. Разъехавшись, эти две
// половины дали бы кнопки, которые нажимаются и молча ничего не делают.

import { createHmac, timingSafeEqual } from 'node:crypto'

import { escapeMarkdownV2 } from '../../shared/lead.js'
import { formatTimestamp, renderLeadMessage } from './lead-message.js'

/**
 * Статусы заявки. Те же четыре значения, что в CHECK таблицы leads:
 * кнопки в чате не заводят собственный словарь состояний.
 */
export const CRM_STATUSES = Object.freeze(['new', 'in_progress', 'done', 'spam'])

export const CRM_STATUS_LABELS = Object.freeze({
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Обработана',
  spam: 'Спам',
})

// Односимвольные коды вместо самих статусов: в callback_data всего 64 байта,
// и тратить их на слово 'in_progress' незачем — расшифровка всё равно живёт
// здесь же и никуда не уезжает.
const STATUS_TO_CODE = Object.freeze({ new: 'n', in_progress: 'p', done: 'd', spam: 's' })
const CODE_TO_STATUS = Object.freeze({ n: 'new', p: 'in_progress', d: 'done', s: 'spam' })

// Версия формата в первом поле: формат кнопок когда-нибудь изменится, а
// сообщения со старыми кнопками останутся в чате навсегда. Без версии такое
// нажатие пришлось бы разбирать угадыванием.
const FORMAT = 'v1'

// Длины подписи хватает: подделка даёт одну попытку на нажатие, ответ на
// неудачу неинформативен, а весь выигрыш атакующего — смена статуса заявки,
// уже лежащей в его же чате.
const SIGNATURE_LENGTH = 12

const signature = (secret, payload) =>
  createHmac('sha256', String(secret)).update(payload, 'utf8').digest('hex').slice(0, SIGNATURE_LENGTH)

/**
 * Подпись сравнивается за постоянное время.
 *
 * Не потому, что тайминг здесь реально эксплуатируем, а потому что дешевле
 * не заводить исключение из правила: побайтовое сравнение секретов в коде —
 * это то, что потом копируют в место, где оно уже важно.
 */
const signatureMatches = (expected, actual) => {
  const a = Buffer.from(String(expected), 'utf8')
  const b = Buffer.from(String(actual ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Значение callback_data для кнопки.
 *
 * ЗАЧЕМ ПОДПИСЬ. Обычный участник чата нажимает только те кнопки, что видит,
 * но callback_data — это то, что клиент присылает нам, а не то, что мы ему
 * дали: у любого, кто может обратиться к Bot API от имени этого бота, иначе
 * появилась бы возможность выставить статус произвольной заявке по номеру.
 * Подпись привязывает пару «заявка + статус» к секрету приложения.
 *
 * @param {{secret: string, leadId: number, status: string}} params
 * @returns {string} не длиннее 64 байт, как требует Bot API
 */
export const encodeCallbackData = ({ secret, leadId, status }) => {
  const code = STATUS_TO_CODE[status]
  if (!code) throw new TypeError(`lead-crm: неизвестный статус ${status}`)
  const body = `${FORMAT}:${Number(leadId)}:${code}`
  return `${body}:${signature(secret, body)}`
}

/**
 * Разбирает callback_data обратно.
 *
 * @returns {{ok: true, leadId: number, status: string}
 *          |{ok: false, error: 'malformed'|'bad_signature'}}
 */
export const decodeCallbackData = ({ secret, data }) => {
  const parts = String(data ?? '').split(':')
  if (parts.length !== 4) return { ok: false, error: 'malformed' }

  const [format, rawLeadId, code, sig] = parts
  if (format !== FORMAT) return { ok: false, error: 'malformed' }
  if (!/^\d{1,10}$/.test(rawLeadId)) return { ok: false, error: 'malformed' }

  const status = CODE_TO_STATUS[code]
  if (!status) return { ok: false, error: 'malformed' }

  if (!signatureMatches(signature(secret, `${format}:${rawLeadId}:${code}`), sig)) {
    return { ok: false, error: 'bad_signature' }
  }

  return { ok: true, leadId: Number(rawLeadId), status }
}

/**
 * Клавиатура под карточкой.
 *
 * Текущий статус помечен галкой и остаётся нажимаемым: кнопка, исчезающая
 * при выборе, заставляет гадать, применилось ли нажатие.
 *
 * @param {{secret: string, leadId: number, current: string}} params
 */
export const buildStatusKeyboard = ({ secret, leadId, current }) => ({
  inline_keyboard: [
    CRM_STATUSES.slice(0, 2),
    CRM_STATUSES.slice(2),
  ].map((row) =>
    row.map((status) => ({
      text: `${status === current ? '✅ ' : ''}${CRM_STATUS_LABELS[status]}`,
      callback_data: encodeCallbackData({ secret, leadId, status }),
    }))
  ),
})

/**
 * Строка о текущем статусе, приписываемая к карточке при редактировании.
 *
 * Отдельной строкой, а не заменой всего текста: карточку читают глазами, и
 * данные заявки должны оставаться на своих местах после каждого нажатия.
 */
export const renderStatusLine = ({ status, actor, at, formatTimestamp }) => {
  const label = CRM_STATUS_LABELS[status] ?? status
  const who = actor ? ` · ${escapeMarkdownV2(String(actor))}` : ''
  const when = at && formatTimestamp ? ` · ${escapeMarkdownV2(formatTimestamp(at))}` : ''
  return `\n\n📌 *Статус:* ${escapeMarkdownV2(label)}${who}${when}`
}

/**
 * Карточка заявки целиком: текст и клавиатура под ним.
 *
 * ОДНА ФУНКЦИЯ НА ОБА НАПРАВЛЕНИЯ. Статус меняется из двух мест — кнопкой
 * в чате и селектом в админке, — и каждое из них перерисовывает одно и то же
 * сообщение. Две отдельные сборки означали бы, что после правки из панели
 * карточка в чате начинает выглядеть иначе, чем после нажатия кнопки, причём
 * заметить это можно только сравнив два сообщения глазами.
 *
 * @param {{template: string, lead: object, status: string, actor: string,
 *          at: number, secret: string}} params
 * @returns {{text: string, replyMarkup: object}}
 */
export const renderLeadCard = ({ template, lead, status, actor, at, secret }) => ({
  text:
    renderLeadMessage(template, {
      name: lead.name,
      phone: lead.phone,
      message: lead.message,
      locale: lead.locale,
      createdAt: lead.created_at ?? lead.createdAt,
    }) + renderStatusLine({ status, actor, at, formatTimestamp }),
  replyMarkup: buildStatusKeyboard({ secret, leadId: lead.id, current: status }),
})

/** Отображаемое имя нажавшего: @username, иначе имя и фамилия. */
export const actorName = (from) => {
  if (!from || typeof from !== 'object') return 'неизвестно'
  if (from.username) return `@${String(from.username).slice(0, 32)}`
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
  return name ? name.slice(0, 64) : `id${from.id}`
}
