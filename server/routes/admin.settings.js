// HTTP-слой настроек приложения: чтение списка, запись значения и проверка
// связи с Telegram. Всё, что не относится к транспорту, лежит рядом:
//
//   server/repositories/settings.js      — таблица settings и шифрование;
//   server/application/settings-service.js — схема, проверка, типизированное
//                                            чтение и запись;
//   server/application/telegram-config.js  — настройки бота с умолчаниями;
//   server/domain/lead-message.js          — шаблон сообщения по заявке.
//
// ПОЧЕМУ ЭТО НЕ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ. Токен бота, id чата, шаблон сообщения
// и лимиты формы правятся по живому: сменили бота — правка не должна требовать
// доступа к панели хостинга и перезапуска пула. Переменные окружения остаются
// как значение по умолчанию (config.*), а строка в settings его перекрывает.
//
// СЕКРЕТ НИКОГДА НЕ УХОДИТ НАРУЖУ. Это главное правило раздела. GET отдаёт по
// секретным ключам только маску вида 'dpl_****4f2a' и признак isSet;
// расшифрованное значение не попадает ни в один ответ, ни в audit_log, ни
// в текст ошибки. Причина простая: список настроек открывается на каждом заходе
// в раздел, а значит уезжает в кэш браузера, в скриншот и в чужие глаза
// за плечом. Прочитать секрет может только серверный код через readSetting() —
// то есть ровно тот, кто собирается им воспользоваться.
//
// ВСЁ СОСТОЯНИЕ В SQLITE. Passenger держит пул процессов, поэтому счётчика
// отправок тестовых сообщений в Map() здесь нет: соседний процесс о нём
// не узнает. Кэш настроек в памяти есть, но он инвалидируется ревизией
// таблицы (см. settings-service.js), то есть правка соседнего процесса
// подхватывается на следующем чтении.

import { getSettingsService } from '../application/settings-service.js'
import { resolveTelegramConfig } from '../application/telegram-config.js'
import { WEBHOOK_PATH, webhookSecretFor } from '../application/telegram-crm.js'
import { renderLeadMessage } from '../domain/lead-message.js'
import { verifyCsrf } from '../auth/csrf.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { readJson } from '../http/body.js'
import { json } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import { isOfficialApiBase, telegramGateway } from '../integrations/telegram.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'

// Реэкспорт ради модулей, которые пришли за этими именами сюда до разделения
// (admin.leads.js, admin.media.js, admin.operations.js). Новый код должен
// импортировать их из модулей выше.
export {
  SETTINGS_KEYS,
  SETTINGS_SCHEMA,
  readSetting,
  validateSettingValue,
} from '../application/settings-service.js'
export {
  DEFAULT_TELEGRAM_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
  formatTimestamp,
  renderLeadMessage,
  renderTemplate,
} from '../domain/lead-message.js'
export { resolveTelegramConfig as resolveTelegram } from '../application/telegram-config.js'

// Шаблон и список защищённых терминов — самые длинные значения в таблице.
// 32 КБ покрывают их с запасом, всё остальное читать незачем.
const BODY_LIMIT = 32 * 1024

// Ответ Bot API приходит быстро либо не приходит вовсе. Восемь секунд — тот же
// потолок, что и у конвейера заявки: дольше держать запрос админки нет смысла.
const TELEGRAM_TIMEOUT_MS = 8_000

// Проверочное сообщение уходит в рабочий чат отдела продаж, поэтому кнопка
// «проверить» не должна превращаться в способ его засорить.
const TEST_WINDOW_MS = 5 * 60_000
const TEST_MAX = 5

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, ?, ?, ?, 'settings', ?, ?, ?, ?)
`

/**
 * Запись в журнал. Значения настроек в diff НЕ ПОПАДАЮТ: у секретов туда
 * уехал бы токен целиком, а журнал читают из админки и выгружают в бэкап.
 * Фиксируем факт изменения и признак «значение задано/снято».
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
    // Журнал не должен ломать сохранение настройки: строка уже записана,
    // и откатывать её из-за неудачной записи в аудит нечестно по отношению
    // к тому, кто нажал «сохранить».
    console.error(`[settings] аудит не записан (${entry.action}): ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Отправка в Telegram
// ---------------------------------------------------------------------------

/**
 * Отправляет сообщение через Bot API.
 *
 * Возвращает { ok: true, messageId } либо { ok: false, error, description }.
 * Не бросает: недоступный бот — это ожидаемое состояние, а не сбой сервера.
 *
 * Токен в результат не попадает НИКОГДА, в том числе в текст ошибки: описание
 * от Telegram обрезается и не содержит URL, а сам URL нигде не логируется —
 * иначе токен оказался бы в логе Plesk, который читают по любому поводу.
 *
 * @param {{botToken: string, chatId: string, text: string, apiBase?: string,
 *          timeoutMs?: number}} options
 */
export const sendTelegramMessage = async (options) => {
  const {
    botToken,
    chatId,
    text,
    apiBase = config.telegramApiBase,
    timeoutMs = TELEGRAM_TIMEOUT_MS,
    replyMarkup = null,
  } = options

  const result = await telegramGateway.send({
    botToken,
    chatId,
    text,
    apiBase,
    timeoutMs,
    replyMarkup,
  })

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.responseCode,
      description: result.description ?? '',
      migrateToChatId: result.migrateToChatId ?? null,
    }
  }

  return { ok: true, messageId: result.messageId, degraded: Boolean(result.degraded) }
}

// ---------------------------------------------------------------------------
// Общая обвязка маршрутов
// ---------------------------------------------------------------------------

// Лимитер держит счётчики в базе: у пула процессов Passenger общая только она.
// Создаётся один раз на соединение (конструктор делает prepare), WeakMap —
// чтобы закрытая в тестах база не удерживалась в памяти.
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
 * Живая сессия с нужной ролью и, для мутаций, пройденной проверкой CSRF.
 *
 * Отказ на уровне сессии отвечает НЕОТЛИЧИМО от несуществующего адреса:
 * честный 401 подтвердил бы сканеру, что путь /api/admin/* угадан, а вся
 * маскировка админки держится именно на этом. Отказ по роли — наоборот,
 * честный 403: человек уже вошёл, и прятать от него нечего.
 *
 * @returns {{user: object, session: object, ipHash: string}|null}
 *   null означает, что ответ уже отправлен.
 */
const authorize = async (db, req, res, options = {}) => {
  const { mutation = false, contentTypes } = options
  const requestContext = ensureRequestContext(req)

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
      // 415 отличается от 403 намеренно: неверный Content-Type — ошибка
      // клиента, а не подозрение на подделку запроса.
      json(res, csrf.error === 'unsupported_media_type' ? 415 : 403, {
        ok: false,
        error: csrf.error,
      })
      return null
    }
  }

  const { ipHash } = requestContext

  if (!hasCapability(access.user, CAPABILITY.SETTINGS_MANAGE)) {
    audit(db, {
      userId: access.user.id,
      actor: access.user.username,
      action: 'settings.denied',
      ipHash,
      diff: { role: access.user.role },
      result: 'denied',
    })
    json(res, 403, { ok: false, error: 'forbidden' })
    return null
  }

  return { user: access.user, session: access.session, ipHash }
}

const readBody = async (req, res) => {
  const body = await readJson(req, { limit: BODY_LIMIT })
  if (body.ok) return body.value

  json(res, body.error === 'payload_too_large' ? 413 : 400, { ok: false, error: body.error })
  return null
}

// ---------------------------------------------------------------------------
// GET /api/admin/settings
// ---------------------------------------------------------------------------

/**
 * Список настроек. Отдаются ВСЕ ключи схемы, даже незаполненные: интерфейс
 * рисует форму по этому ответу, и ключ, которого нет в базе, обязан появиться
 * в ней с умолчанием, а не исчезнуть.
 */
const listHandler = (db) => async (req, res) => {
  const ctx = await authorize(db, req, res)
  if (!ctx) return

  json(res, 200, { ok: true, items: getSettingsService(db).list() })
}

// ---------------------------------------------------------------------------
// PUT /api/admin/settings
// ---------------------------------------------------------------------------

/** Diff для журнала. Секретное значение в него не попадает даже частично. */
const auditDiff = (written) =>
  written.isSecret
    ? { secret: true, wasSet: written.wasSet, isSet: written.isSet }
    : // Для несекретных ключей значение полезно (по нему видно, кто выкрутил
      // лимит формы), но длину ограничиваем: шаблон сообщения раздул бы
      // каждую запись журнала.
      { wasSet: written.wasSet, value: String(written.encoded).slice(0, 300) }

const putHandler = (db) => async (req, res) => {
  const ctx = await authorize(db, req, res, { mutation: true })
  if (!ctx) return

  const body = await readBody(req, res)
  if (!body) return

  const key = typeof body.key === 'string' ? body.key.trim() : ''
  const settings = getSettingsService(db)

  if (!settings.schema[key]) {
    // Неизвестный ключ — это либо опечатка фронтенда, либо попытка записать
    // в таблицу что-то своё. И то и другое пишем в журнал: настройки читает
    // прикладной код, и подложенный ключ мог бы им однажды подхватиться.
    audit(db, {
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'settings.update',
      entityId: key.slice(0, 64) || null,
      ipHash: ctx.ipHash,
      diff: { reason: 'unknown_key' },
      result: 'denied',
    })
    json(res, 400, { ok: false, error: 'unknown_key' })
    return
  }

  const checked = settings.validate(key, body.value)
  if (!checked.ok) {
    json(res, 400, { ok: false, error: 'invalid_value', key, reason: checked.reason })
    return
  }

  const now = Date.now()
  const result = settings.write(key, checked, {
    userId: ctx.user.id,
    now,
    // Журнал пишется в той же транзакции, что и сама запись: откатившееся
    // сохранение не должно оставить в audit_log след об изменении.
    onWrite: (written) =>
      audit(db, {
        at: now,
        userId: ctx.user.id,
        actor: ctx.user.username,
        action: 'settings.update',
        entityId: key,
        ipHash: ctx.ipHash,
        diff: auditDiff(written),
      }),
  })

  json(res, 200, {
    ok: true,
    key,
    isSecret: result.isSecret,
    isSet: result.isSet,
    ...(result.isSecret ? { preview: result.preview } : { value: result.value }),
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/settings/telegram-test
// ---------------------------------------------------------------------------

// Значения намеренно очевидно тестовые: сообщение уходит в рабочий чат отдела
// продаж, и менеджер не должен принять его за настоящую заявку.
const TEST_LEAD = Object.freeze({
  name: 'Тест Тестов',
  phone: '+998 90 000 00 00',
  message: 'Проверка настроек бота из админки. Это не заявка.',
  locale: 'ru',
})

// Шапка с уже экранированными скобками: она часть шаблона, а не значение,
// и экранированию при подстановке не подлежит (см. renderTemplate).
const TEST_HEADER = '⚙️ *Проверка настроек PROHVAC* \\(это не заявка\\)'

/**
 * Отправляет тестовое сообщение текущим шаблоном и текущим токеном.
 *
 * Единственный способ убедиться, что бот настроен, не создавая фальшивую
 * заявку в таблице leads: любая проверка «через форму» оставила бы мусор
 * в отчётах и в счётчиках конверсии.
 */
const telegramTestHandler = (db) => async (req, res) => {
  const ctx = await authorize(db, req, res, { mutation: true })
  if (!ctx) return

  // Тело не нужно, но вычитать его обязательно: CSRF требует
  // Content-Type: application/json, значит клиент пришлёт хотя бы '{}',
  // а непрочитанный поток остаётся в сокете и мешает следующему запросу
  // того же keep-alive-соединения.
  const body = await readBody(req, res)
  if (!body) return

  const now = Date.now()
  const limit = limiterFor(db).hit(`settings-tgtest:${ctx.user.id}`, {
    windowMs: TEST_WINDOW_MS,
    max: TEST_MAX,
    now,
  })
  if (!limit.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((limit.resetAt - now) / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    json(res, 429, { ok: false, error: 'rate_limited', retryAfterSec })
    return
  }

  // Один снимок конфигурации на весь обработчик: правка настроек между
  // проверкой и отправкой не должна дать токен от одного бота и chat_id
  // от другого.
  const telegram = resolveTelegramConfig(db)
  if (!telegram.botToken || !telegram.chatId) {
    json(res, 409, { ok: false, error: 'not_configured' })
    return
  }

  const text = `${TEST_HEADER}\n${renderLeadMessage(telegram.template, {
    ...TEST_LEAD,
    createdAt: now,
  })}`

  // Самое ценное, что даёт эта кнопка. Подменённый адрес Bot API — это заявки,
  // уходящие в заглушку при полностью зелёном интерфейсе: раньше проверка в
  // такой конфигурации отвечала «отправлено», и убедиться, что бот НЕ настроен,
  // было нечем. Отвечаем отказом, а не пометкой: «успех» здесь означает, что
  // сообщение видно в рабочем чате, а его там нет.
  if (!isOfficialApiBase(telegram.apiBase)) {
    audit(db, {
      at: Date.now(),
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'settings.telegram_test',
      entityId: 'telegram',
      ipHash: ctx.ipHash,
      diff: { outcome: 'api_base_overridden', apiBase: telegram.apiBase },
      result: 'error',
    })
    json(res, 409, {
      ok: false,
      error: 'api_base_overridden',
      apiBase: telegram.apiBase,
      description:
        `Отправка идёт не в Telegram, а на ${telegram.apiBase}. ` +
        'Это локальная заглушка: уберите TELEGRAM_API_BASE из окружения.',
    })
    return
  }

  // Проверка токена и доступности чата ДО отправки: 401 и «chat not found»
  // называют причину прямо, а неудачный sendMessage сообщает только о том,
  // что что-то не сработало.
  const identity = await telegramGateway.getMe({
    botToken: telegram.botToken,
    apiBase: telegram.apiBase,
    timeoutMs: TELEGRAM_TIMEOUT_MS,
  })
  if (!identity.ok) {
    json(res, 502, {
      ok: false,
      error: identity.error,
      description: identity.description ?? '',
    })
    return
  }

  const result = await sendTelegramMessage({
    botToken: telegram.botToken,
    chatId: telegram.chatId,
    text,
    apiBase: telegram.apiBase,
  })

  audit(db, {
    at: Date.now(),
    userId: ctx.user.id,
    actor: ctx.user.username,
    action: 'settings.telegram_test',
    entityId: 'telegram',
    ipHash: ctx.ipHash,
    // chatId — не секрет, а токен в diff не попадает даже частично.
    diff: { chatId: telegram.chatId, outcome: result.ok ? 'sent' : result.error },
    result: result.ok ? 'ok' : 'error',
  })

  if (!result.ok) {
    // 502, а не 500: наш код отработал, отказал внешний сервис. Описание
    // от Telegram («chat not found», «can't parse entities») — единственное,
    // что подсказывает, что именно чинить в настройках.
    json(res, result.error === 'not_configured' ? 409 : 502, {
      ok: false,
      error: result.error,
      description: result.description ?? '',
    })
    return
  }

  json(res, 200, {
    ok: true,
    messageId: result.messageId,
    chatId: telegram.chatId,
    botUsername: identity.result?.username ?? null,
    // Шаблон сломан, но сообщение доставлено простым текстом. Молчать об этом
    // нельзя: в чате карточка выглядит «почти правильно», и разметку чинить
    // никто не пойдёт.
    degraded: Boolean(result.degraded),
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/settings/telegram-webhook
// ---------------------------------------------------------------------------

/**
 * Подключает (или отключает) кнопки статуса в чате.
 *
 * ЗАЧЕМ КНОПКА, А НЕ АВТОМАТИКА. setWebhook — это разовое действие, которое
 * говорит Telegram, куда слать нажатия. Делать его на каждом старте нельзя:
 * процессов у Passenger несколько, и они наперегонки переустанавливали бы
 * один и тот же адрес. Делать его руками через curl — значит требовать от
 * оператора обращаться к Bot API с боевым токеном в командной строке.
 *
 * Секрет заголовка выводится из APP_SECRET и наружу не отдаётся: он нужен
 * только Telegram и нам, а показанный в интерфейсе секрет рано или поздно
 * оказывается в переписке.
 */
const telegramWebhookHandler = (db) => async (req, res) => {
  const ctx = await authorize(db, req, res, { mutation: true })
  if (!ctx) return

  const body = await readBody(req, res)
  if (!body) return

  const telegram = resolveTelegramConfig(db)
  if (!telegram.botToken) {
    json(res, 409, { ok: false, error: 'not_configured' })
    return
  }

  const enable = body.enable !== false
  const transport = { botToken: telegram.botToken, apiBase: telegram.apiBase, timeoutMs: TELEGRAM_TIMEOUT_MS }

  if (!enable) {
    const removed = await telegramGateway.deleteWebhook({ drop_pending_updates: false }, transport)
    audit(db, {
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'settings.telegram_webhook',
      entityId: 'telegram',
      ipHash: ctx.ipHash,
      diff: { enabled: false },
      result: removed.ok ? 'ok' : 'error',
    })
    json(res, removed.ok ? 200 : 502, { ok: removed.ok, enabled: false, error: removed.error })
    return
  }

  // Вебхук обязан быть https: Telegram не ходит по http и не ходит на
  // loopback. Отвечаем понятной причиной, а не отказом Bot API.
  const url = `${config.publicOrigin}${WEBHOOK_PATH}`
  if (!url.startsWith('https://')) {
    json(res, 409, {
      ok: false,
      error: 'public_origin_not_https',
      description:
        `Telegram шлёт нажатия только по https, а PUBLIC_ORIGIN=${config.publicOrigin}. ` +
        'Локально кнопки проверяются прогоном обновления прямо в вебхук.',
    })
    return
  }

  const result = await telegramGateway.setWebhook(
    {
      url,
      secret_token: webhookSecretFor(config.appSecret),
      // Нас интересуют только нажатия на кнопки: подписка на сообщения
      // означала бы поток чужой переписки через наш сервер.
      allowed_updates: ['callback_query'],
      max_connections: 10,
    },
    transport
  )

  audit(db, {
    userId: ctx.user.id,
    actor: ctx.user.username,
    action: 'settings.telegram_webhook',
    entityId: 'telegram',
    ipHash: ctx.ipHash,
    diff: { enabled: true, url },
    result: result.ok ? 'ok' : 'error',
  })

  if (!result.ok) {
    json(res, 502, { ok: false, error: result.error, description: result.description ?? '' })
    return
  }

  json(res, 200, { ok: true, enabled: true, url })
}

// ---------------------------------------------------------------------------
// Регистрация маршрутов
// ---------------------------------------------------------------------------

/**
 * Вешает маршруты настроек на роутер API.
 *
 * @param {{register: Function}} router роутер из server/router.js
 * @param {{db: object}} deps соединение из server/db/index.js
 */
export const registerAdminSettingsRoutes = (router, deps = {}) => {
  const { db } = deps
  if (!router || typeof router.register !== 'function') {
    throw new TypeError('admin.settings: ожидается роутер из server/router.js')
  }
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('admin.settings: в deps.db нужно соединение из server/db/index.js')
  }

  // Конкретный путь регистрируется до общего: у роутера '/api/admin/settings'
  // и '/api/admin/settings/telegram-test' — разные наборы сегментов, поэтому
  // порядок здесь не критичен, но привычка полезная.
  router.register('POST', '/api/admin/settings/telegram-test', telegramTestHandler(db))
  router.register('POST', '/api/admin/settings/telegram-webhook', telegramWebhookHandler(db))
  router.register('GET', '/api/admin/settings', listHandler(db))
  router.register('PUT', '/api/admin/settings', putHandler(db))

  return router
}
