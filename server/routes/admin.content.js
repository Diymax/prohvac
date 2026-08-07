// Редактирование текстов и структурных сущностей лендинга из админки.
//
// ГЛАВНОЕ ПРАВИЛО ФАЙЛА: РУЧНУЮ ПРАВКУ НЕЛЬЗЯ ПЕРЕТИРАТЬ МАШИННЫМ ПЕРЕВОДОМ.
// Правка русского текста делает переводы устаревшими, и заманчиво тут же
// отправить их все в очередь. Но перевод, который человек уже выверил
// (is_locked = 1), после автоперевода восстановить неоткуда: старое значение
// затёрто, а замечают такое через месяцы, когда носитель языка случайно
// открывает страницу. Устаревший текст — проблема обратимая: он виден в
// админке как 'stale' и правится одной кнопкой. Поэтому заблокированные
// переводы в очередь НЕ ставятся, а только помечаются устаревшими; перетереть
// их можно лишь явным force в массовом переводе.
//
// СТАТУС ПЕРЕВОДА НЕ ХРАНИТСЯ, А ВЫЧИСЛЯЕТСЯ. В content_entries нет колонки
// «состояние»: она неизбежно разъехалась бы с данными. Достаточно того, что
// уже есть: пустое значение — 'missing'; source_hash, разошедшийся с хешем
// текущего русского текста, — 'stale'; is_locked — 'manual'; всё остальное —
// 'machine'. Любая правка любым путём (админка, seed, ручной SQL) немедленно
// отражается в статусе, потому что статуса как отдельного факта не существует.
//
// ОЧЕРЕДЬ СТАВИТСЯ ПОСЛЕ COMMIT, А НЕ ВНУТРИ ТРАНЗАКЦИИ. Сохранение текста и
// постановка задач — события разной цены. Текст, который человек только что
// написал, потерять нельзя; задача перевода восстановима массовым прогоном
// (POST /api/admin/content/translate) и видна в админке как 'stale'. Поэтому
// сбой очереди не откатывает правку: языки, которые не удалось поставить,
// возвращаются в stale, а не в queued. Плюс к тому enqueueTranslation пишет
// другой модуль, и он имеет право быть асинхронным — внутри db.transaction()
// такой вызов молча потерял бы атомарность (см. driver.js).
//
// ВСЁ СОСТОЯНИЕ В SQLITE. Passenger держит пул процессов: номер ревизии
// контента, позиции элементов и очередь — общие только через базу. Отсюда же
// инкремент content_generation одним UPSERT'ом, а не парой SELECT + UPDATE.

import { createHash } from 'node:crypto'

import { verifyCsrf } from '../auth/csrf.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { readJson } from '../http/body.js'
import { json } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'

// Список локалей совпадает с CHECK в content_entries.locale. Дублируется
// намеренно: неизвестный язык должен отсекаться проверкой по списку, а не
// уходить в SQL и падать на ограничении таблицы.
const LOCALES = Object.freeze(['ru', 'en', 'uz', 'tr', 'ar'])
const SOURCE_LOCALE = 'ru'
const TARGET_LOCALES = Object.freeze(LOCALES.filter((locale) => locale !== SOURCE_LOCALE))

const JSON_ONLY = Object.freeze(['application/json'])

// Тело правки текста: одно поле value с описанием проекта. 16 КБ с запасом —
// самый длинный текст лендинга около тысячи символов.
const TEXT_BODY_LIMIT = 16 * 1024
// Массовый перевод принимает список ключей, поэтому лимит выше.
const BULK_BODY_LIMIT = 64 * 1024
const ENTITY_BODY_LIMIT = 8 * 1024

// Потолок длины одного значения. Ограничение не косметическое: значение
// уходит в очередь перевода и оплачивается по символам у провайдера.
const VALUE_MAX = 8000

// Ключ контента: 'hero.title', 'projects.caex.desc'. Сегменты валидируем
// по одному, потому что ключ раскладывается в дерево i18next на клиенте
// (см. buildTree в public.content.js), и мусорный сегмент там теряется молча.
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const KEY_MAX_LENGTH = 160
const KEY_MAX_SEGMENTS = 8

// Имена, ломающие объект-словарь на клиенте. Тот же список, что в
// public.content.js: там вторая линия обороны, здесь первая.
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

// Префикс, под который уезжают тексты удалённой сущности. Удалять их нельзя:
// это переводы на четыре языка, сделанные и выверенные руками, а причина
// удаления обычно «проект временно снимаем с сайта». Под этим префиксом ключи
// не совпадают ни с одним, который читает фронтенд, и возвращаются на место
// сами, если сущность с тем же slug'ом заводят заново.
//
// Цена решения честная: архивные ключи продолжают попадать в /locales/*.json
// и весят там несколько килобайт на удалённый проект. Это дешевле, чем
// безвозвратно стереть переводы, и вычищается разовым скриптом уборки.
const ARCHIVE_PREFIX = 'archived.'

// Шаг между позициями. Тот же, что в scripts/seed-content.mjs: с единичным
// шагом вставка в середину требовала бы перенумеровать весь список.
const POSITION_STEP = 10

// Потолок задач на один массовый перевод. Полный прогон всех ключей на все
// языки — это около полутора тысяч задач; ограничение защищает не базу,
// а квоту провайдера от случайного force по всему сайту дважды подряд.
const MAX_BULK_JOBS = 2000

// Фотографий в галерее проекта. Больше тридцати — это уже не портфолио,
// а способ выесть диск на 500 МБ через одну форму.
const MAX_PHOTOS = 30

// ---------------------------------------------------------------------------
// Хеш исходного текста
// ---------------------------------------------------------------------------

/**
 * Канонический вид значения перед хешированием и записью.
 *
 * trim и NFC обязаны применяться ОДИНАКОВО при записи и при сравнении, иначе
 * скопированный из вёрстки текст с концевым пробелом (или с разложенной
 * формой «й») давал бы другой хеш и делал бы все переводы устаревшими на
 * пустом месте. Значение сохраняется уже нормализованным — тогда
 * hash(сохранённое значение) === source_hash выполняется всегда.
 */
const normalizeText = (value) => String(value ?? '').trim().normalize('NFC')

const sha256hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Хеш исходного (русского) текста для content_entries.source_hash. */
const hashSource = (value) => sha256hex(normalizeText(value))

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SQL_ALL_ENTRIES = `
  SELECT locale, key, value, source, is_locked, source_hash, updated_at
    FROM content_entries
`

const SQL_ENTRIES_BY_KEY = `
  SELECT locale, key, value, source, is_locked, source_hash, updated_at
    FROM content_entries
   WHERE key = ?
`

// provider и translated_at сбрасываются: правка руками — это не результат
// работы провайдера, и оставленная от него отметка врала бы в админке.
const SQL_UPSERT_ENTRY = `
  INSERT INTO content_entries (
    locale, key, value, source, is_locked, source_hash, provider, translated_at, updated_at
  ) VALUES (?, ?, ?, 'manual', 1, ?, NULL, NULL, ?)
  ON CONFLICT(locale, key) DO UPDATE SET
    value         = excluded.value,
    source        = 'manual',
    is_locked     = 1,
    source_hash   = excluded.source_hash,
    provider      = NULL,
    translated_at = NULL,
    updated_at    = excluded.updated_at
`

const SQL_INSERT_BLANK_ENTRY = `
  INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash, updated_at)
  VALUES (?, ?, '', 'manual', 1, ?, ?)
  ON CONFLICT(locale, key) DO NOTHING
`

const SQL_RENAME_KEY = 'UPDATE content_entries SET key = ?, updated_at = ? WHERE key = ?'

const SQL_DELETE_KEY = 'DELETE FROM content_entries WHERE key = ?'

const SQL_COUNT_KEY = 'SELECT COUNT(*) AS n FROM content_entries WHERE key = ?'

// Инкремент одним запросом: пул процессов Passenger читает и пишет эту строку
// параллельно, и пара SELECT + UPDATE потеряла бы часть увеличений. CAST от
// нечислового значения даёт 0, то есть испорченная строка чинится сама.
const SQL_BUMP_GENERATION = `
  INSERT INTO app_state (key, value, updated_at) VALUES ('content_generation', '1', ?)
  ON CONFLICT(key) DO UPDATE SET
    value      = CAST(CAST(app_state.value AS INTEGER) + 1 AS TEXT),
    updated_at = excluded.updated_at
`

// Дедупликация опирается на частичный уникальный индекс translation_jobs_pending_uniq:
// незавершённая задача на пару (key, lang) может быть только одна, поэтому
// предварительный SELECT не нужен — и не был бы надёжен при нескольких процессах.
const SQL_ENQUEUE_JOB = `
  INSERT INTO translation_jobs (
    key, lang, source_text, source_hash, status, run_after, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)
  ON CONFLICT (key, lang) WHERE status IN ('queued', 'running', 'deferred')
  DO UPDATE SET
    source_text = excluded.source_text,
    source_hash = excluded.source_hash,
    status      = 'queued',
    run_after   = 0,
    -- CR-062. Возврат задачи в очередь снимает и аренду CR-039: строка со
    -- status = 'queued' и живым claim_until утверждает, что её кто-то держит,
    -- хотя держать нечего — работа ещё не начата. Сегодня это никого не путает
    -- (каждый потребитель аренды требует status = 'running'), но ровно такое
    -- расхождение состояния с реальностью аренда и заводилась убрать.
    claim_owner = NULL,
    claim_token = NULL,
    claim_until = 0,
    updated_at  = excluded.updated_at
`

const SQL_AUDIT = `
  INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, ip_hash, diff, result)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const SQL_MEDIA_LIVE = 'SELECT id FROM media WHERE id = ? AND deleted_at IS NULL'

// ---------------------------------------------------------------------------
// Мелочь общего назначения
// ---------------------------------------------------------------------------

const ok = (res, payload = {}) => json(res, 200, { ok: true, ...payload })

const fail = (res, status, error, extra = {}) =>
  json(res, status, { ok: false, error, ...extra })

/**
 * Запись в журнал. Сбой журнала не должен ронять уже выполненное действие,
 * поэтому исключение гасится в лог: строка аудита ценна, но правка контента
 * ценнее, а откатывать её из-за неудачной вставки в audit_log незачем.
 */
const audit = (db, entry) => {
  try {
    db.run(SQL_AUDIT, [
      entry.at ?? Date.now(),
      entry.userId ?? null,
      entry.actor || 'anonymous',
      entry.action,
      entry.entity ?? null,
      entry.entityId == null ? null : String(entry.entityId),
      entry.ipHash ?? null,
      entry.diff == null ? null : JSON.stringify(entry.diff),
      entry.result ?? 'ok',
    ])
  } catch (error) {
    console.error(`[admin.content] аудит не записан (${entry.action}): ${error.message}`)
  }
}

/**
 * Доступ к маршруту. Отказ на уровне сессии отвечает НЕОТЛИЧИМО от
 * несуществующего адреса: 401 или 403 подтвердили бы сканеру, что путь
 * /api/admin/* угадан, а на секретности этого пути держится вся защита
 * админки (см. server/auth/guard.js). Отказ уже опознанному пользователю —
 * наоборот, честный JSON: он вошёл, прятать от него нечего.
 *
 * @returns {{user: object, session: object, ipHash: string}|null}
 *   null означает, что ответ уже отправлен.
 */
const authorize = async (db, req, res, options = {}) => {
  const { mutation = true, contentTypes = JSON_ONLY } = options

  const access = requireActive(db, req)
  if (!access.ok) {
    await denyAsNotFound(req, res)
    return null
  }

  const { ipHash } = ensureRequestContext(req)
  if (!mutation) return { user: access.user, session: access.session, ipHash }

  const csrf = verifyCsrf(req, access.session, {
    publicOrigin: config.publicOrigin,
    contentTypes,
  })
  if (!csrf.ok) {
    // 415 отличается от 403 намеренно: неверный Content-Type — ошибка клиента,
    // а не подозрение на подделку запроса, и отлаживать её иначе пришлось бы
    // наугад.
    fail(res, csrf.error === 'unsupported_media_type' ? 415 : 403, csrf.error)
    return null
  }

  if (!hasCapability(access.user, CAPABILITY.CONTENT_WRITE)) {
    // Попытка сделать то, на что нет прав, интереснее самого действия.
    audit(db, {
      userId: access.user.id,
      actor: access.user.username,
      action: 'content.denied',
      entity: 'content',
      ipHash,
      diff: { role: access.user.role, path: req.url },
      result: 'denied',
    })
    fail(res, 403, 'forbidden')
    return null
  }

  return { user: access.user, session: access.session, ipHash }
}

const readBody = async (req, res, limit) => {
  const body = await readJson(req, { limit })
  if (body.ok) return body.value

  fail(res, body.error === 'payload_too_large' ? 413 : 400, body.error)
  return null
}

/** Параметры запроса. req.url приходит сырым, с query — путь нормализует app.js. */
const queryOf = (req) => {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

const bumpGeneration = (db, now) => db.run(SQL_BUMP_GENERATION, [now])

const isValidKey = (key) => {
  if (typeof key !== 'string' || !key || key.length > KEY_MAX_LENGTH) return false
  const segments = key.split('.')
  if (segments.length > KEY_MAX_SEGMENTS) return false
  return segments.every(
    (segment) => KEY_SEGMENT.test(segment) && !UNSAFE_SEGMENTS.has(segment)
  )
}

// ---------------------------------------------------------------------------
// Постановка в очередь перевода
// ---------------------------------------------------------------------------

/**
 * Запасная реализация постановки задачи. Используется, когда deps не принёс
 * enqueueTranslation: модуль обязан оставаться работоспособным сам по себе,
 * иначе правка текста молча перестанет порождать переводы, а заметят это
 * по пустым языкам через неделю.
 *
 * Контракт для внешней реализации (server/translate/worker.js) ровно такой же:
 *   enqueueTranslation({db, key, lang, sourceText, sourceHash, now, force})
 * Возврат игнорируется, промис допускается — вызов идёт после COMMIT.
 */
const defaultEnqueue = ({ db, key, lang, sourceText, sourceHash, now }) => {
  db.run(SQL_ENQUEUE_JOB, [key, lang, sourceText, sourceHash, now, now])
}

// ---------------------------------------------------------------------------
// GET /api/admin/content
// ---------------------------------------------------------------------------

/**
 * Статус перевода. Порядок проверок значим: заблокированный, но устаревший
 * перевод обязан показываться как 'stale' — именно он требует внимания
 * человека, потому что автоперевод его не тронет (см. шапку файла).
 *
 * @param {object|undefined} row строка content_entries
 * @param {string|null} sourceHash хеш текущего русского текста
 * @param {boolean} isSource считается ли эта локаль исходной
 */
const statusOf = (row, sourceHash, isSource) => {
  if (!row || !row.value || !row.value.trim()) return 'missing'
  // Исходник не может устареть относительно самого себя, поэтому сверка
  // хешей для ru не проводится вовсе.
  if (!isSource && sourceHash && row.source_hash !== sourceHash) return 'stale'
  return row.is_locked === 1 ? 'manual' : 'machine'
}

/** Группирует плоскую выборку в карту key -> locale -> строка. */
const groupByKey = (rows) => {
  const byKey = new Map()
  for (const row of rows) {
    let group = byKey.get(row.key)
    if (!group) {
      group = new Map()
      byKey.set(row.key, group)
    }
    group.set(row.locale, row)
  }
  return byKey
}

const sectionOf = (key) => key.split('.')[0]

const listContentHandler = ({ db }) => async (req, res) => {
  const ctx = await authorize(db, req, res, { mutation: false })
  if (!ctx) return

  const section = queryOf(req).get('section')
  const byKey = groupByKey(db.all(SQL_ALL_ENTRIES))

  const keys = []
  const sections = new Map()

  for (const [key, group] of byKey) {
    // Архивные ключи удалённых сущностей в редакторе не показываем: они
    // никому не адресованы и только засоряют список.
    if (key.startsWith(ARCHIVE_PREFIX)) continue

    const name = sectionOf(key)
    sections.set(name, (sections.get(name) ?? 0) + 1)
    if (section && name !== section) continue

    const sourceRow = group.get(SOURCE_LOCALE)
    const sourceValue = sourceRow?.value ?? ''
    // Хеша нет, когда русского текста ещё нет: сверять переводы не с чем,
    // и объявлять их устаревшими было бы неправдой.
    const sourceHash = sourceValue.trim() ? hashSource(sourceValue) : null

    const values = {}
    const status = {}
    let updatedAt = 0

    for (const locale of LOCALES) {
      const row = group.get(locale)
      values[locale] = row?.value ?? ''
      status[locale] = statusOf(row, sourceHash, locale === SOURCE_LOCALE)
      if (row && row.updated_at > updatedAt) updatedAt = row.updated_at
    }

    keys.push({ key, section: name, values, status, updatedAt })
  }

  // Порядок фиксируем сами: выборка без ORDER BY отдаёт строки в порядке
  // хранения, и список ключей в админке прыгал бы от запроса к запросу.
  keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  ok(res, {
    keys,
    sections: [...sections.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    locales: LOCALES,
    total: keys.length,
  })
}

// ---------------------------------------------------------------------------
// PUT /api/admin/content/:key
// ---------------------------------------------------------------------------

/**
 * Что делать с языком после правки исходника.
 *
 * Три исхода и все три возвращаются клиенту: редактор обязан видеть, что
 * именно произошло с каждым языком, иначе «сохранил и ничего не изменилось»
 * приходится выяснять по базе.
 */
const planForLang = (row, sourceHash) => {
  // Перевод уже сделан ровно с этого текста — очередь не нужна.
  if (row && row.source_hash === sourceHash && row.value.trim()) return 'upToDate'
  // Ручная правка. Только помечаем устаревшей (это следует из разошедшихся
  // хешей и вычисляется само) и НЕ трогаем: см. шапку файла.
  if (row && row.is_locked === 1 && row.value.trim()) return 'stale'
  return 'queue'
}

const updateContentHandler = ({ db, enqueue }) => async (req, res, params) => {
  const ctx = await authorize(db, req, res)
  if (!ctx) return

  const body = await readBody(req, res, TEXT_BODY_LIMIT)
  if (!body) return

  const key = params?.key ?? ''
  if (!isValidKey(key) || key.startsWith(ARCHIVE_PREFIX)) {
    fail(res, 400, 'invalid_key')
    return
  }

  const lang = typeof body.lang === 'string' ? body.lang : ''
  if (!LOCALES.includes(lang)) {
    fail(res, 400, 'invalid_lang')
    return
  }

  if (typeof body.value !== 'string') {
    fail(res, 400, 'invalid_value')
    return
  }
  const value = normalizeText(body.value)
  if (value.length > VALUE_MAX) {
    fail(res, 400, 'value_too_long', { maxLength: VALUE_MAX })
    return
  }

  const now = Date.now()
  const hash = sha256hex(value)

  const outcome = db.transaction(() => {
    const group = new Map(db.all(SQL_ENTRIES_BY_KEY, [key]).map((row) => [row.locale, row]))
    const current = group.get(lang)
    const isSource = lang === SOURCE_LOCALE

    // Сохранение без изменений — самая частая операция в редакторе (открыл,
    // посмотрел, нажал «сохранить»). Она не имеет права ни сдвинуть ревизию
    // контента, ни потратить квоту провайдера на перевод того же текста.
    if (isSource && current && sha256hex(normalizeText(current.value)) === hash) {
      return { unchanged: true }
    }

    // Для перевода source_hash — это хеш РУССКОГО текста, которому он
    // соответствует. Ручная правка перевода означает «выверено по текущему
    // исходнику», иначе она мгновенно показывалась бы устаревшей.
    const sourceValue = isSource ? value : normalizeText(group.get(SOURCE_LOCALE)?.value ?? '')
    const sourceHash = isSource ? hash : (sourceValue ? sha256hex(sourceValue) : null)

    db.run(SQL_UPSERT_ENTRY, [lang, key, value, sourceHash, now])
    bumpGeneration(db, now)

    const plan = { queue: [], stale: [], upToDate: [] }
    // Переводы пересматриваются только при правке исходника: правка en
    // на другие языки не влияет никак.
    if (isSource && value) {
      for (const target of TARGET_LOCALES) {
        plan[planForLang(group.get(target), hash)].push(target)
      }
    }

    audit(db, {
      at: now,
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'content.update',
      entity: 'content',
      // Ключ аудита — пара локаль/ключ: колонка entity_id объявлена TEXT
      // именно под такие составные идентификаторы (см. схему).
      entityId: `${lang}|${key}`,
      ipHash: ctx.ipHash,
      // Прежнее значение в журнале — единственный способ откатить случайную
      // затирку текста. Обрезаем, чтобы одна правка не раздула audit_log.
      diff: {
        before: (current?.value ?? '').slice(0, 2000),
        after: value.slice(0, 2000),
        queued: plan.queue,
        stale: plan.stale,
      },
    })

    return { unchanged: false, plan, sourceText: value }
  })

  if (outcome.unchanged) {
    ok(res, { key, lang, unchanged: true, queued: [], stale: [], upToDate: [] })
    return
  }

  const { plan } = outcome
  const queued = []
  const queueFailed = []

  for (const target of plan.queue) {
    try {
      await enqueue({
        db,
        key,
        lang: target,
        sourceText: outcome.sourceText,
        sourceHash: hash,
        now,
        force: false,
      })
      queued.push(target)
    } catch (error) {
      // Задача не встала — текст всё равно сохранён. Язык честно уходит
      // в stale: там ему и место, пока перевод не сделан.
      console.error(`[admin.content] очередь ${key}/${target}: ${error.message}`)
      queueFailed.push(target)
    }
  }

  ok(res, {
    key,
    lang,
    unchanged: false,
    queued,
    stale: [...plan.stale, ...queueFailed],
    upToDate: plan.upToDate,
    ...(queueFailed.length ? { queueFailed } : {}),
  })
}

// ---------------------------------------------------------------------------
// POST /api/admin/content/translate
// ---------------------------------------------------------------------------

const translateHandler = ({ db, enqueue }) => async (req, res) => {
  const ctx = await authorize(db, req, res)
  if (!ctx) return

  const body = await readBody(req, res, BULK_BODY_LIMIT)
  if (!body) return

  const force = body.force === true

  let onlyKeys = null
  if (body.keys !== undefined) {
    if (!Array.isArray(body.keys) || body.keys.some((key) => !isValidKey(key))) {
      fail(res, 400, 'invalid_keys')
      return
    }
    onlyKeys = new Set(body.keys)
  }

  let langs = TARGET_LOCALES
  if (body.langs !== undefined) {
    if (!Array.isArray(body.langs) || body.langs.some((lang) => !TARGET_LOCALES.includes(lang))) {
      fail(res, 400, 'invalid_langs')
      return
    }
    langs = [...new Set(body.langs)]
  }

  const byKey = groupByKey(db.all(SQL_ALL_ENTRIES))
  const targets = []
  const skipped = { locked: 0, upToDate: 0, noSource: 0 }
  let truncated = false

  for (const [key, group] of byKey) {
    if (key.startsWith(ARCHIVE_PREFIX)) continue
    if (onlyKeys && !onlyKeys.has(key)) continue

    const sourceText = normalizeText(group.get(SOURCE_LOCALE)?.value ?? '')
    // Переводить нечего: пустой исходник дал бы пустой перевод и потраченный
    // запрос к провайдеру.
    if (!sourceText) {
      skipped.noSource += 1
      continue
    }
    const sourceHash = sha256hex(sourceText)

    for (const lang of langs) {
      if (targets.length >= MAX_BULK_JOBS) {
        truncated = true
        break
      }

      const row = group.get(lang)
      if (!force) {
        const plan = planForLang(row, sourceHash)
        if (plan === 'upToDate') {
          skipped.upToDate += 1
          continue
        }
        if (plan === 'stale') {
          // Заблокированный перевод без force не трогаем никогда.
          skipped.locked += 1
          continue
        }
      }

      targets.push({ key, lang, sourceText, sourceHash })
    }
    if (truncated) break
  }

  const now = Date.now()
  let queued = 0
  const failed = []

  for (const target of targets) {
    try {
      await enqueue({ db, ...target, now, force })
      queued += 1
    } catch (error) {
      console.error(`[admin.content] очередь ${target.key}/${target.lang}: ${error.message}`)
      failed.push(`${target.key}|${target.lang}`)
    }
  }

  audit(db, {
    at: now,
    userId: ctx.user.id,
    actor: ctx.user.username,
    action: 'content.translate',
    entity: 'content',
    ipHash: ctx.ipHash,
    diff: { force, langs, keys: onlyKeys ? onlyKeys.size : null, queued, failed: failed.length },
  })

  ok(res, {
    queued,
    skipped,
    ...(failed.length ? { failed: failed.slice(0, 20) } : {}),
    ...(truncated ? { truncated: true, limit: MAX_BULK_JOBS } : {}),
  })
}

// ---------------------------------------------------------------------------
// Сущности: описание типов
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const STAT_KEY_PATTERN = /^[a-z0-9_]{1,64}$/
const E164_PATTERN = /^\+[0-9]{7,15}$/
const ID_PATTERN = /^[1-9][0-9]{0,9}$/
const STATUSES = new Set(['published', 'hidden'])
const TONES = new Set(['cold', 'warm'])

/**
 * Описание таблиц. Имена таблиц и колонок берутся ТОЛЬКО отсюда и никогда
 * из запроса: тип из URL сначала ищется в этом объекте, и всё, что в нём не
 * нашлось, до SQL не доходит.
 *
 * contentKeys — ключи content_entries, которыми владеет строка. Тексты живут
 * не в таблице сущности, потому что их пять языков на каждый (см. схему).
 */
const DESCRIPTORS = Object.freeze({
  projects: {
    table: 'projects',
    idColumn: 'id',
    idKind: 'number',
    hasUpdatedAt: true,
    contentKeys: (row) => ['tag', 'title', 'card', 'desc'].map((f) => `projects.${row.slug}.${f}`),
  },
  partners: {
    table: 'partners',
    idColumn: 'id',
    idKind: 'number',
    hasUpdatedAt: true,
    // Название партнёра — это данные, а не перевод: логотипы не переводят.
    contentKeys: () => [],
  },
  advantages: {
    table: 'advantages',
    idColumn: 'id',
    idKind: 'number',
    hasUpdatedAt: false,
    // Исторический префикс из локалей — 'services', а не 'advantages'
    // (см. scripts/seed-content.mjs). Переименование ключей стоило бы
    // переводов, а выигрыш был бы косметический.
    contentKeys: (row) => ['title', 'desc'].map((f) => `services.${row.slug}.${f}`),
  },
  stats: {
    table: 'stats',
    idColumn: 'key',
    idKind: 'statKey',
    hasUpdatedAt: true,
    contentKeys: (row) => [`ratings.${row.key}`],
  },
  phones: {
    table: 'phones',
    idColumn: 'id',
    idKind: 'number',
    hasUpdatedAt: false,
    contentKeys: () => [],
  },
})

const parseEntityId = (kind, raw) => {
  const value = String(raw ?? '')
  if (kind === 'number') {
    // Своя проверка, а не Number(): '01', '1e3' и '1.0' дают валидное число,
    // но это уже не тот идентификатор, который написали в URL, — и в аудите
    // осталось бы не то, что происходило.
    return ID_PATTERN.test(value) ? Number(value) : null
  }
  return STAT_KEY_PATTERN.test(value) ? value : null
}

// ---------------------------------------------------------------------------
// Сущности: валидация полей
// ---------------------------------------------------------------------------

/** Ошибка валидации поля. Отдельный класс, чтобы отличать её от сбоя базы. */
class FieldError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const bad = (code) => {
  throw new FieldError(code)
}

const has = (body, field) => Object.hasOwn(body, field)

const asStatus = (value) => {
  if (!STATUSES.has(value)) bad('invalid_status')
  return value
}

const asTone = (value) => {
  if (!TONES.has(value)) bad('invalid_tone')
  return value
}

const asPosition = (value) => {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) bad('invalid_position')
  return value
}

/**
 * Идентификатор медиа. Проверяется существование и то, что файл не помечен
 * удалённым: ссылка на мягко удалённую строку пережила бы уборщика и
 * превратилась бы в битую картинку.
 */
const asMediaId = (db, value) => {
  if (value === null) return null
  if (!Number.isInteger(value) || value <= 0) bad('invalid_media_id')
  if (!db.get(SQL_MEDIA_LIVE, [value])) bad('media_not_found')
  return value
}

const asSlug = (value) => {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) bad('invalid_slug')
  return value
}

const asName = (value) => {
  const name = normalizeText(value)
  if (!name || name.length > 120) bad('invalid_name')
  return name
}

/**
 * Ссылка партнёра. Только https и только абсолютная: значение попадает в href,
 * и 'javascript:' там — исполняемый код. Тот же запрет продублирован CHECK'ом
 * в схеме, здесь он нужен ради внятной ошибки вместо SQLITE_CONSTRAINT.
 */
const asHttpsUrl = (value) => {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 500) bad('invalid_url')
  let url
  try {
    url = new URL(value)
  } catch {
    return bad('invalid_url')
  }
  if (url.protocol !== 'https:') bad('invalid_url')
  return url.toString()
}

const asStatValue = (value) => {
  const text = normalizeText(value)
  if (!text || text.length > 32) bad('invalid_value')
  return text
}

const asHeroSlot = (value) => {
  if (value === null) return null
  if (!Number.isInteger(value) || value < 1 || value > 4) bad('invalid_hero_slot')
  return value
}

const asE164 = (value) => {
  const text = String(value ?? '').replace(/[\s()-]/g, '')
  if (!E164_PATTERN.test(text)) bad('invalid_e164')
  return text
}

const asPhotoList = (db, value) => {
  if (!Array.isArray(value)) bad('invalid_photos')
  if (value.length > MAX_PHOTOS) bad('too_many_photos')
  const ids = []
  for (const item of value) {
    const id = asMediaId(db, item)
    if (id == null) bad('invalid_media_id')
    // Пара (project_id, media_id) — первичный ключ галереи: одно фото дважды
    // в списке не ошибка данных, а ошибка ввода, и молча схлопывать её нельзя.
    if (ids.includes(id)) bad('duplicate_photo')
    ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Сущности: чтение
// ---------------------------------------------------------------------------

const MEDIA_URL_PREFIX = '/media/'

const mediaOf = (filename, width, height, id) => {
  if (!filename) return null
  return {
    id: id ?? null,
    url: `${MEDIA_URL_PREFIX}${encodeURIComponent(filename)}`,
    w: width ?? null,
    h: height ?? null,
  }
}

const SQL_LIST_PROJECTS = `
  SELECT p.id, p.slug, p.status, p.position, p.cover_media_id, p.updated_at,
         m.filename AS cover_file, m.width AS cover_w, m.height AS cover_h
    FROM projects p
    LEFT JOIN media m ON m.id = p.cover_media_id AND m.deleted_at IS NULL
   ORDER BY p.position, p.id
`

// Мягко удалённые файлы из галереи НЕ выбрасываются, а помечаются: админка
// должна показывать, что фотография осталась привязанной к пропавшему файлу,
// иначе снимок исчезает из списка молча и «сохранить» затирает привязку.
const SQL_LIST_PROJECT_PHOTOS = `
  SELECT ph.project_id, ph.media_id, ph.position,
         m.filename, m.width, m.height, m.deleted_at
    FROM project_photos ph
    JOIN media m ON m.id = ph.media_id
   ORDER BY ph.project_id, ph.position, ph.media_id
`

const SQL_LIST_PARTNERS = `
  SELECT pa.id, pa.name, pa.url, pa.status, pa.position, pa.media_id, pa.updated_at,
         m.filename, m.width, m.height
    FROM partners pa
    LEFT JOIN media m ON m.id = pa.media_id AND m.deleted_at IS NULL
   ORDER BY pa.position, pa.id
`

const SQL_LIST_ADVANTAGES = `
  SELECT a.id, a.slug, a.tone, a.status, a.position, a.icon_media_id,
         m.filename, m.width, m.height
    FROM advantages a
    LEFT JOIN media m ON m.id = a.icon_media_id AND m.deleted_at IS NULL
   ORDER BY a.position, a.id
`

const SQL_LIST_STATS =
  'SELECT key, value, tone, hero_slot, position, updated_at FROM stats ORDER BY position, key'

const SQL_LIST_PHONES = 'SELECT id, e164, status, position FROM phones ORDER BY position, id'

const SQL_SOURCE_VALUES = 'SELECT key, value FROM content_entries WHERE locale = ?'

/**
 * Собирает все сущности одним ответом. Подпись на русском подмешивается
 * из content_entries: без неё список в админке — это набор slug'ов, по
 * которому невозможно понять, какой из шести проектов какой.
 */
const collectEntities = (db) => {
  const labels = new Map(
    db.all(SQL_SOURCE_VALUES, [SOURCE_LOCALE]).map((row) => [row.key, row.value])
  )
  const label = (key) => labels.get(key) ?? ''

  const photosByProject = new Map()
  for (const row of db.all(SQL_LIST_PROJECT_PHOTOS)) {
    const list = photosByProject.get(row.project_id) ?? []
    list.push({
      mediaId: row.media_id,
      position: row.position,
      deleted: row.deleted_at != null,
      media: mediaOf(row.filename, row.width, row.height, row.media_id),
    })
    photosByProject.set(row.project_id, list)
  }

  return {
    projects: db.all(SQL_LIST_PROJECTS).map((row) => ({
      id: row.id,
      slug: row.slug,
      status: row.status,
      position: row.position,
      coverMediaId: row.cover_media_id,
      cover: mediaOf(row.cover_file, row.cover_w, row.cover_h, row.cover_media_id),
      photos: photosByProject.get(row.id) ?? [],
      title: label(`projects.${row.slug}.title`),
      contentKeys: DESCRIPTORS.projects.contentKeys(row),
      updatedAt: row.updated_at,
    })),
    partners: db.all(SQL_LIST_PARTNERS).map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      status: row.status,
      position: row.position,
      mediaId: row.media_id,
      logo: mediaOf(row.filename, row.width, row.height, row.media_id),
      updatedAt: row.updated_at,
    })),
    advantages: db.all(SQL_LIST_ADVANTAGES).map((row) => ({
      id: row.id,
      slug: row.slug,
      tone: row.tone,
      status: row.status,
      position: row.position,
      iconMediaId: row.icon_media_id,
      icon: mediaOf(row.filename, row.width, row.height, row.icon_media_id),
      title: label(`services.${row.slug}.title`),
      contentKeys: DESCRIPTORS.advantages.contentKeys(row),
    })),
    stats: db.all(SQL_LIST_STATS).map((row) => ({
      key: row.key,
      value: row.value,
      tone: row.tone,
      heroSlot: row.hero_slot,
      position: row.position,
      label: label(`ratings.${row.key}`),
      contentKeys: DESCRIPTORS.stats.contentKeys(row),
      updatedAt: row.updated_at,
    })),
    phones: db.all(SQL_LIST_PHONES).map((row) => ({
      id: row.id,
      e164: row.e164,
      status: row.status,
      position: row.position,
    })),
  }
}

const listEntitiesHandler = ({ db }) => async (req, res) => {
  const ctx = await authorize(db, req, res, { mutation: false })
  if (!ctx) return

  ok(res, collectEntities(db))
}

// ---------------------------------------------------------------------------
// Сущности: тексты
// ---------------------------------------------------------------------------

/**
 * Заводит ключи текстов новой сущности.
 *
 * Если такие ключи уже лежат в архиве (сущность с тем же slug'ом когда-то
 * удаляли), они возвращаются на место со всеми переводами — ради этого архив
 * и существует. Иначе создаётся пустая русская строка: ключ обязан быть виден
 * в редакторе сразу, иначе человек не узнает, что его нужно заполнить.
 */
const createContentKeys = (db, keys, now) => {
  const restored = []
  for (const key of keys) {
    if (db.get(SQL_COUNT_KEY, [key]).n > 0) continue

    const archived = `${ARCHIVE_PREFIX}${key}`
    if (db.get(SQL_COUNT_KEY, [archived]).n > 0) {
      db.run(SQL_RENAME_KEY, [key, now, archived])
      restored.push(key)
      continue
    }

    db.run(SQL_INSERT_BLANK_ENTRY, [SOURCE_LOCALE, key, sha256hex(''), now])
  }
  return restored
}

/** Уводит тексты удалённой сущности в архив. См. ARCHIVE_PREFIX. */
const archiveContentKeys = (db, keys, now) => {
  let moved = 0
  for (const key of keys) {
    const archived = `${ARCHIVE_PREFIX}${key}`
    // Прошлый архив того же ключа мешает переименованию (первичный ключ
    // (locale, key)). Он и не нужен: свежие переводы полнее старых.
    db.run(SQL_DELETE_KEY, [archived])
    moved += db.run(SQL_RENAME_KEY, [archived, now, key]).changes
  }
  return moved
}

// ---------------------------------------------------------------------------
// Сущности: создание и обновление
// ---------------------------------------------------------------------------

const nextPosition = (db, table) => {
  const row = db.get(`SELECT COALESCE(MAX(position), 0) AS max FROM ${table}`)
  return (row?.max ?? 0) + POSITION_STEP
}

const assertFree = (db, table, column, value, error) => {
  if (db.get(`SELECT 1 AS found FROM ${table} WHERE ${column} = ?`, [value])) bad(error)
}

/**
 * Слот в первом экране уникален (частичный UNIQUE в схеме). Освобождаем его
 * у прежнего владельца заранее: иначе обмен слотами двух цифр падал бы на
 * промежуточном состоянии, где слот занят дважды.
 */
const freeHeroSlot = (db, slot, exceptKey) => {
  if (slot == null) return
  db.run('UPDATE stats SET hero_slot = NULL WHERE hero_slot = ? AND key <> ?', [slot, exceptKey])
}

const replacePhotos = (db, projectId, photos) => {
  db.run('DELETE FROM project_photos WHERE project_id = ?', [projectId])
  photos.forEach((mediaId, index) => {
    db.run(
      'INSERT INTO project_photos (project_id, media_id, position) VALUES (?, ?, ?)',
      [projectId, mediaId, (index + 1) * POSITION_STEP]
    )
  })
}

/** Создание строки. Возвращает {id, row} либо бросает FieldError. */
const createEntity = (db, type, body, now) => {
  switch (type) {
    case 'projects': {
      const slug = asSlug(body.slug)
      assertFree(db, 'projects', 'slug', slug, 'slug_taken')
      const cover = has(body, 'coverMediaId') ? asMediaId(db, body.coverMediaId) : null
      // status по умолчанию 'hidden': новый проект не должен появиться на
      // сайте раньше, чем к нему привяжут фотографии и переводы.
      const status = has(body, 'status') ? asStatus(body.status) : 'hidden'
      const position = has(body, 'position') ? asPosition(body.position) : nextPosition(db, 'projects')
      const photos = has(body, 'photos') ? asPhotoList(db, body.photos) : []

      const info = db.run(
        `INSERT INTO projects (slug, cover_media_id, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [slug, cover, position, status, now, now]
      )
      const id = Number(info.lastInsertRowid)
      if (photos.length) replacePhotos(db, id, photos)
      return { id, row: { id, slug } }
    }

    case 'partners': {
      const name = asName(body.name)
      const url = has(body, 'url') ? asHttpsUrl(body.url) : null
      const mediaId = has(body, 'mediaId') ? asMediaId(db, body.mediaId) : null
      const status = has(body, 'status') ? asStatus(body.status) : 'published'
      const position = has(body, 'position') ? asPosition(body.position) : nextPosition(db, 'partners')

      const info = db.run(
        `INSERT INTO partners (name, media_id, url, position, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, mediaId, url, position, status, now]
      )
      const id = Number(info.lastInsertRowid)
      return { id, row: { id, name } }
    }

    case 'advantages': {
      const slug = asSlug(body.slug)
      assertFree(db, 'advantages', 'slug', slug, 'slug_taken')
      const icon = has(body, 'iconMediaId') ? asMediaId(db, body.iconMediaId) : null
      const tone = has(body, 'tone') ? asTone(body.tone) : 'cold'
      const status = has(body, 'status') ? asStatus(body.status) : 'published'
      const position = has(body, 'position') ? asPosition(body.position) : nextPosition(db, 'advantages')

      const info = db.run(
        `INSERT INTO advantages (slug, icon_media_id, tone, position, status)
         VALUES (?, ?, ?, ?, ?)`,
        [slug, icon, tone, position, status]
      )
      const id = Number(info.lastInsertRowid)
      return { id, row: { id, slug } }
    }

    case 'stats': {
      const key = String(body.key ?? '')
      if (!STAT_KEY_PATTERN.test(key)) bad('invalid_key')
      assertFree(db, 'stats', 'key', key, 'key_taken')
      const value = asStatValue(body.value)
      const tone = has(body, 'tone') ? asTone(body.tone) : 'cold'
      const heroSlot = has(body, 'heroSlot') ? asHeroSlot(body.heroSlot) : null
      const position = has(body, 'position') ? asPosition(body.position) : nextPosition(db, 'stats')

      freeHeroSlot(db, heroSlot, key)
      db.run(
        `INSERT INTO stats (key, value, tone, hero_slot, position, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [key, value, tone, heroSlot, position, now]
      )
      return { id: key, row: { key } }
    }

    case 'phones': {
      const e164 = asE164(body.e164)
      assertFree(db, 'phones', 'e164', e164, 'e164_taken')
      const status = has(body, 'status') ? asStatus(body.status) : 'published'
      const position = has(body, 'position') ? asPosition(body.position) : nextPosition(db, 'phones')

      const info = db.run(
        'INSERT INTO phones (e164, position, status) VALUES (?, ?, ?)',
        [e164, position, status]
      )
      const id = Number(info.lastInsertRowid)
      return { id, row: { id, e164 } }
    }

    default:
      return bad('unknown_type')
  }
}

/**
 * Частичное обновление: меняются только присланные поля.
 *
 * slug и stats.key неизменяемы намеренно. По ним адресуются ключи текстов
 * (projects.<slug>.title и далее), и переименование сущности молча оторвало бы
 * от неё все пять языков. Нужен другой slug — заводится новая сущность,
 * а тексты старой уезжают в архив и оттуда восстанавливаются.
 */
const updateEntity = (db, type, row, body, now) => {
  const sets = []
  const values = []
  const set = (column, value) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }

  if (has(body, 'slug') && body.slug !== row.slug) bad('slug_immutable')
  if (has(body, 'key') && type === 'stats' && body.key !== row.key) bad('key_immutable')

  switch (type) {
    case 'projects':
      if (has(body, 'coverMediaId')) set('cover_media_id', asMediaId(db, body.coverMediaId))
      if (has(body, 'status')) set('status', asStatus(body.status))
      if (has(body, 'position')) set('position', asPosition(body.position))
      if (has(body, 'photos')) replacePhotos(db, row.id, asPhotoList(db, body.photos))
      break

    case 'partners':
      if (has(body, 'name')) set('name', asName(body.name))
      if (has(body, 'url')) set('url', asHttpsUrl(body.url))
      if (has(body, 'mediaId')) set('media_id', asMediaId(db, body.mediaId))
      if (has(body, 'status')) set('status', asStatus(body.status))
      if (has(body, 'position')) set('position', asPosition(body.position))
      break

    case 'advantages':
      if (has(body, 'iconMediaId')) set('icon_media_id', asMediaId(db, body.iconMediaId))
      if (has(body, 'tone')) set('tone', asTone(body.tone))
      if (has(body, 'status')) set('status', asStatus(body.status))
      if (has(body, 'position')) set('position', asPosition(body.position))
      break

    case 'stats':
      if (has(body, 'value')) set('value', asStatValue(body.value))
      if (has(body, 'tone')) set('tone', asTone(body.tone))
      if (has(body, 'heroSlot')) {
        const slot = asHeroSlot(body.heroSlot)
        freeHeroSlot(db, slot, row.key)
        set('hero_slot', slot)
      }
      if (has(body, 'position')) set('position', asPosition(body.position))
      break

    case 'phones':
      if (has(body, 'e164')) {
        const e164 = asE164(body.e164)
        if (e164 !== row.e164) assertFree(db, 'phones', 'e164', e164, 'e164_taken')
        set('e164', e164)
      }
      if (has(body, 'status')) set('status', asStatus(body.status))
      if (has(body, 'position')) set('position', asPosition(body.position))
      break

    default:
      return bad('unknown_type')
  }

  const descriptor = DESCRIPTORS[type]
  if (!sets.length) return 0

  if (descriptor.hasUpdatedAt) set('updated_at', now)
  values.push(row[descriptor.idColumn])

  return db.run(
    `UPDATE ${descriptor.table} SET ${sets.join(', ')} WHERE ${descriptor.idColumn} = ?`,
    values
  ).changes
}

// ---------------------------------------------------------------------------
// Сущности: обработчики
// ---------------------------------------------------------------------------

const descriptorFor = (params) => {
  const type = params?.type ?? ''
  // Object.hasOwn, а не DESCRIPTORS[type]: 'constructor' и 'toString' пришли
  // бы из прототипа и дошли бы до сборки SQL.
  return Object.hasOwn(DESCRIPTORS, type) ? { type, descriptor: DESCRIPTORS[type] } : null
}

const loadRow = (db, descriptor, id) =>
  db.get(`SELECT * FROM ${descriptor.table} WHERE ${descriptor.idColumn} = ?`, [id])

/** Выполняет действие с сущностью, превращая FieldError в 400. */
const runGuarded = (res, action) => {
  try {
    return { ok: true, value: action() }
  } catch (error) {
    if (error instanceof FieldError) {
      fail(res, 400, error.code)
      return { ok: false }
    }
    throw error
  }
}

const createEntityHandler = ({ db }) => async (req, res, params) => {
  const ctx = await authorize(db, req, res)
  if (!ctx) return

  const found = descriptorFor(params)
  if (!found) {
    fail(res, 404, 'unknown_type')
    return
  }

  const body = await readBody(req, res, ENTITY_BODY_LIMIT)
  if (!body) return

  const now = Date.now()
  const result = runGuarded(res, () =>
    db.transaction(() => {
      const created = createEntity(db, found.type, body, now)
      const keys = found.descriptor.contentKeys(created.row)
      const restored = createContentKeys(db, keys, now)
      bumpGeneration(db, now)

      audit(db, {
        at: now,
        userId: ctx.user.id,
        actor: ctx.user.username,
        action: 'entity.create',
        entity: found.type,
        entityId: created.id,
        ipHash: ctx.ipHash,
        diff: { after: created.row, contentKeys: keys, restoredKeys: restored },
      })

      return { id: created.id, contentKeys: keys, restoredKeys: restored }
    })
  )
  if (!result.ok) return

  ok(res, { type: found.type, ...result.value, entities: collectEntities(db) })
}

const updateEntityHandler = ({ db }) => async (req, res, params) => {
  const ctx = await authorize(db, req, res)
  if (!ctx) return

  const found = descriptorFor(params)
  if (!found) {
    fail(res, 404, 'unknown_type')
    return
  }

  const id = parseEntityId(found.descriptor.idKind, params?.id)
  if (id == null) {
    fail(res, 404, 'not_found')
    return
  }

  const body = await readBody(req, res, ENTITY_BODY_LIMIT)
  if (!body) return

  const row = loadRow(db, found.descriptor, id)
  if (!row) {
    fail(res, 404, 'not_found')
    return
  }

  const now = Date.now()
  const result = runGuarded(res, () =>
    db.transaction(() => {
      updateEntity(db, found.type, row, body, now)
      const after = loadRow(db, found.descriptor, id)
      bumpGeneration(db, now)

      audit(db, {
        at: now,
        userId: ctx.user.id,
        actor: ctx.user.username,
        action: 'entity.update',
        entity: found.type,
        entityId: id,
        ipHash: ctx.ipHash,
        diff: { before: row, after },
      })

      return after
    })
  )
  if (!result.ok) return

  ok(res, { type: found.type, id, entities: collectEntities(db) })
}

const deleteEntityHandler = ({ db }) => async (req, res, params) => {
  // contentTypes: null — у DELETE нет тела, требовать от него
  // Content-Type: application/json значило бы требовать заголовок ни к чему.
  // Барьеры Origin и X-CSRF-Token при этом остаются на месте.
  const ctx = await authorize(db, req, res, { contentTypes: null })
  if (!ctx) return

  const found = descriptorFor(params)
  if (!found) {
    fail(res, 404, 'unknown_type')
    return
  }

  const id = parseEntityId(found.descriptor.idKind, params?.id)
  if (id == null) {
    fail(res, 404, 'not_found')
    return
  }

  const row = loadRow(db, found.descriptor, id)
  if (!row) {
    fail(res, 404, 'not_found')
    return
  }

  const now = Date.now()
  const keys = found.descriptor.contentKeys(row)

  const archived = db.transaction(() => {
    // Фотографии проекта уносит ON DELETE CASCADE (см. схему), сами файлы
    // остаются в media: их удаляет уборщик, когда убедится, что на файл
    // больше никто не ссылается.
    db.run(
      `DELETE FROM ${found.descriptor.table} WHERE ${found.descriptor.idColumn} = ?`,
      [id]
    )
    const moved = archiveContentKeys(db, keys, now)
    bumpGeneration(db, now)

    audit(db, {
      at: now,
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'entity.delete',
      entity: found.type,
      entityId: id,
      ipHash: ctx.ipHash,
      diff: { before: row, archivedKeys: keys, archivedRows: moved },
    })

    return moved
  })

  ok(res, {
    type: found.type,
    id,
    archivedKeys: keys,
    archivedRows: archived,
    entities: collectEntities(db),
  })
}

/**
 * Переупорядочивание. Позиции переписываются ЦЕЛИКОМ: присланные id получают
 * места по порядку, а всё, что в список не попало, дописывается следом в своём
 * прежнем порядке. Иначе частичный список оставил бы одинаковые позиции у
 * разных строк, и порядок на сайте определял бы планировщик запросов.
 */
const reorderEntitiesHandler = ({ db }) => async (req, res, params) => {
  const ctx = await authorize(db, req, res)
  if (!ctx) return

  const found = descriptorFor(params)
  if (!found) {
    fail(res, 404, 'unknown_type')
    return
  }

  const body = await readBody(req, res, ENTITY_BODY_LIMIT)
  if (!body) return

  if (!Array.isArray(body.ids)) {
    fail(res, 400, 'invalid_ids')
    return
  }

  const { descriptor } = found
  const requested = []
  for (const raw of body.ids) {
    const id = parseEntityId(descriptor.idKind, raw)
    if (id == null || requested.includes(id)) {
      fail(res, 400, 'invalid_ids')
      return
    }
    requested.push(id)
  }

  const existing = db
    .all(`SELECT ${descriptor.idColumn} AS id FROM ${descriptor.table} ORDER BY position, ${descriptor.idColumn}`)
    .map((row) => row.id)
  const known = new Set(existing)

  if (requested.some((id) => !known.has(id))) {
    fail(res, 400, 'unknown_id')
    return
  }

  const order = [...requested, ...existing.filter((id) => !requested.includes(id))]
  const now = Date.now()

  db.transaction(() => {
    order.forEach((id, index) => {
      const position = (index + 1) * POSITION_STEP
      const sql = descriptor.hasUpdatedAt
        ? `UPDATE ${descriptor.table} SET position = ?, updated_at = ? WHERE ${descriptor.idColumn} = ?`
        : `UPDATE ${descriptor.table} SET position = ? WHERE ${descriptor.idColumn} = ?`
      db.run(sql, descriptor.hasUpdatedAt ? [position, now, id] : [position, id])
    })
    bumpGeneration(db, now)

    audit(db, {
      at: now,
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: 'entity.reorder',
      entity: found.type,
      ipHash: ctx.ipHash,
      diff: { order },
    })
  })

  ok(res, { type: found.type, order, entities: collectEntities(db) })
}

// ---------------------------------------------------------------------------
// Регистрация маршрутов
// ---------------------------------------------------------------------------

/**
 * Вешает маршруты редактирования контента на роутер API.
 *
 * @param {{register: Function}} router роутер из server/router.js
 * @param {{db: object, enqueueTranslation?: Function}} deps
 *   db — соединение из server/db/index.js;
 *   enqueueTranslation — постановка задачи перевода из server/translate/worker.js.
 *   Принимается через deps, а не импортируется: модуль не должен зависеть от
 *   готовности воркера, а тесты — подменять его без обращения к очереди.
 *   Сигнатура: ({db, key, lang, sourceText, sourceHash, now, force}) => void|Promise.
 *   Без него используется запись прямо в translation_jobs (defaultEnqueue).
 */
export const registerAdminContentRoutes = (router, deps = {}) => {
  if (!router || typeof router.register !== 'function') {
    throw new TypeError('admin.content: ожидается роутер из server/router.js')
  }
  const { db, enqueueTranslation, translateStatus } = deps
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('admin.content: в deps.db нужно соединение из server/db/index.js')
  }
  if (enqueueTranslation !== undefined && typeof enqueueTranslation !== 'function') {
    throw new TypeError('admin.content: deps.enqueueTranslation должен быть функцией')
  }

  const ctx = { db, enqueue: enqueueTranslation ?? defaultEnqueue }

  router.register('GET', '/api/admin/content', listContentHandler(ctx))
  // Массовый перевод регистрируется ДО параметрического маршрута: 'translate'
  // подошёл бы под ':key', и порядок здесь единственное, что их различает.
  router.register('POST', '/api/admin/content/translate', translateHandler(ctx))
  // Состояние очереди. Экран текстов опрашивает этот адрес, а маршрута для него
  // не было вовсе: блок «в очереди / выполняется / ошибок» не показывался
  // никогда, и залипшую очередь оператор увидеть не мог.
  router.register('GET', '/api/admin/translate/status', async (req, res) => {
    const access = requireActive(db, req)
    if (!access.ok) {
      await denyAsNotFound(req, res)
      return
    }
    const counts = typeof translateStatus === 'function' ? translateStatus() : null
    json(res, 200, { ok: true, queue: counts })
  })
  router.register('PUT', '/api/admin/content/:key', updateContentHandler(ctx))

  router.register('GET', '/api/admin/entities', listEntitiesHandler(ctx))
  router.register('POST', '/api/admin/entities/:type', createEntityHandler(ctx))
  // Та же причина, что и выше: '/entities/:type/reorder' и '/entities/:type/:id'
  // совпадают посегментно, и 'reorder' обязан быть первым.
  router.register('POST', '/api/admin/entities/:type/reorder', reorderEntitiesHandler(ctx))
  router.register('PUT', '/api/admin/entities/:type/:id', updateEntityHandler(ctx))
  router.register('DELETE', '/api/admin/entities/:type/:id', deleteEntityHandler(ctx))

  return router
}
