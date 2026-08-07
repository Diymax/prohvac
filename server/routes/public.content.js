// Отдача контента фронтенду: переводы интерфейса и структурные данные лендинга.
//
// Два адреса, оба публичные и оба только на чтение:
//
//   GET /locales/:lng/translation.json — то же, что раньше лежало в dist/,
//       но собранное из content_entries. Адрес и форма ответа не меняются:
//       по нему уже ходит i18next-http-backend, и правка контракта означала
//       бы правку фронтенда ради того, что фронтенду безразлично.
//   GET /api/site/content — проекты, партнёры, преимущества, цифры и телефоны
//       одним объектом. Один запрос вместо пяти: на мобильной сети стоимость
//       ответа — это в основном round-trip, а не его размер.
//
// КЭШИРОВАНИЕ. Ответы одинаковы для всех посетителей и меняются только из
// админки, поэтому здесь работает связка «ETag + короткий max-age»:
//   - max-age=60, must-revalidate — правка из админки доезжает до посетителя
//     максимум за минуту, и ни один промежуточный кэш не имеет права отдавать
//     просроченное тело, не спросив нас;
//   - ETag делает повторный запрос дешёвым: сервер отвечает 304 без тела,
//     а мы не пересобираем JSON, потому что тело лежит готовым в памяти.
//
// ПОЧЕМУ КЭШ В ПАМЯТИ, НО С ПОКОЛЕНИЕМ ИЗ БАЗЫ. Passenger держит ПУЛ
// процессов. Правка контента приходит в один из них, а держат кэш все, и
// события «контент изменился» между процессами нет — общая у них только база.
// Поэтому номер ревизии (app_state.content_generation) читается из SQLite,
// но не чаще раза в GENERATION_TTL_MS: один SELECT по первичному ключу дёшев,
// однако на каждый запрос каждой картинки страницы он всё равно лишний.
// Плата за этот компромисс — до двух секунд, в течение которых соседний
// процесс может отдать прежний ответ. Для текстов лендинга это приемлемо,
// а для админки — нет, и там ответы идут с no-store (server/http/respond.js).

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { SETTING_KEYS } from '../../shared/settings.js'
import { settingsSnapshot } from '../application/settings-service.js'
import { apiNotFound, json, securityHeaders } from '../http/respond.js'
import { DIST_DIR } from '../http/static.js'

// Список языков совпадает с CHECK в content_entries.locale. Проверка по списку,
// а не по шаблону: параметр приходит из URL, и подстановка его в SQL или в путь
// на диске должна быть невозможна в принципе, а не «после нормализации».
const LOCALES = new Set(['ru', 'en', 'uz', 'tr', 'ar'])

// Как часто перечитывается номер ревизии контента. См. шапку файла.
const GENERATION_TTL_MS = 2000

const CACHE_CONTROL = 'public, max-age=60, must-revalidate'
const CONTENT_TYPE = 'application/json; charset=utf-8'

// Медиа отдаёт server/app.js из DATA_DIR по этому префиксу.
const MEDIA_URL_PREFIX = '/media/'

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * ETag = поколение + sha256 тела.
 *
 * Хеша тела достаточно, чтобы поймать любое изменение, но поколение в теге
 * нужно отдельно: по нему видно, из какой ревизии контента собран ответ, и два
 * процесса пула, разошедшихся на одну публикацию, не могут случайно выдать
 * одинаковый тег на разные тела.
 */
const etagFor = (generation, body) =>
  `"${generation}-${createHash('sha256').update(body).digest('hex')}"`

/**
 * Сверка If-None-Match. W/-префикс снимаем: тело целое, слабое и сильное
 * сравнение дают один результат, а клиенты присылают оба вида.
 * (Такая же проверка есть в http/static.js, но там она приватная, а тащить
 * её в общий модуль ради пяти строк — лишний слой.)
 */
const etagMatches = (header, etag) => {
  if (typeof header !== 'string' || !header) return false
  if (header.trim() === '*') return true
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
}

/**
 * Отправляет готовую запись кэша: 304, если у клиента та же версия, иначе 200
 * с телом. json() из respond.js здесь не годится — он ставит no-store, а весь
 * смысл этих двух маршрутов в том, что их ответы кэшируются.
 */
const sendEntry = (req, res, entry) => {
  securityHeaders(res)
  res.setHeader('ETag', entry.etag)
  res.setHeader('Cache-Control', CACHE_CONTROL)

  if (etagMatches(req.headers['if-none-match'], entry.etag)) {
    res.statusCode = 304
    // Content-Length у 304 не ставим: часть прокси считает такой ответ битым
    // и обрывает keep-alive (та же причина, что и в respond.js).
    res.end()
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', CONTENT_TYPE)
  res.setHeader('Content-Length', String(entry.body.length))
  // HEAD обязан отдавать те же заголовки, что GET, но без тела.
  res.end(req.method === 'HEAD' ? undefined : entry.body)
}

// ---------------------------------------------------------------------------
// Переводы
// ---------------------------------------------------------------------------

const SQL_ENTRIES = 'SELECT key, value FROM content_entries WHERE locale = ? ORDER BY key'

// Имена, которые нельзя пускать в дерево переводов ни на одном уровне.
// Дело не только в сборке ответа здесь: i18next на клиенте сливает полученный
// объект в свой словарь обычным присваиванием target[key] = value, и ключ
// '__proto__' в теле ответа стал бы записью в прототип уже в браузере.
// Ключи заводит админ, но контент правит не только он, а стоимость проверки —
// одно сравнение на сегмент.
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Разворачивает плоские ключи ('hero.title') во вложенный объект, которого ждёт
 * i18next: {hero: {title: '...'}}. В базе ключ плоский намеренно — так строка
 * перевода адресуется одним значением и в админке, и в очереди автоперевода.
 *
 * Object.create(null) на каждом уровне — вторая линия обороны к списку выше:
 * у объекта без прототипа портить нечего в принципе.
 */
const buildTree = (rows) => {
  const root = Object.create(null)

  for (const row of rows) {
    const segments = String(row.key).split('.')
    // Пустой сегмент ('.hero', 'hero..title') — битый ключ: он дал бы свойство
    // с именем '', невидимое и в интерфейсе, и в JSON.
    if (segments.some((segment) => !segment || UNSAFE_SEGMENTS.has(segment))) continue

    let node = root
    let conflict = false

    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      const next = node[segment]
      if (next === undefined) node[segment] = Object.create(null)
      // По этому пути уже лежит строка: ключи 'hero' и 'hero.title' не могут
      // существовать одновременно. Строки отсортированы по key, то есть более
      // короткий путь пришёл первым и остаётся, а более длинный отбрасывается.
      // Важна не сама победа, а её предсказуемость: иначе набор переводов
      // зависел бы от порядка строк в выборке.
      else if (typeof next !== 'object') {
        conflict = true
        break
      }
      node = node[segment]
    }
    if (conflict) continue

    const leaf = segments[segments.length - 1]
    // Тот же конфликт с другой стороны: по 'hero' уже собран объект из
    // 'hero.title', и класть туда строку значит потерять всю ветку.
    if (typeof node[leaf] === 'object') continue

    node[leaf] = row.value
  }

  return root
}

/**
 * Файл перевода из сборки. Запасной источник на случай, когда в базе для языка
 * нет ни одной строки: до первого сида таблица пуста, и без этой ветки сайт
 * открывался бы скелетом из ключей вместо текста.
 *
 * lng уже проверен по LOCALES, поэтому в join() не может приехать '..'.
 */
const readLocaleFile = async (lng) => {
  const path = join(DIST_DIR, 'locales', lng, 'translation.json')
  try {
    return await fsp.readFile(path)
  } catch (error) {
    console.error(`[content] запасной файл переводов ${lng} недоступен: ${error.message}`)
    return null
  }
}

/** Тело ответа и явный результат чтения: ошибка БД не равна пустой таблице. */
const buildLocaleBody = async (db, lng) => {
  let rows
  try {
    rows = db.all(SQL_ENTRIES, [lng])
  } catch (error) {
    console.error(`[content] чтение переводов ${lng} не удалось: ${error.message}`)
    return { ok: false, body: null }
  }

  if (!rows.length) return { ok: true, body: await readLocaleFile(lng), empty: true }
  return { ok: true, body: Buffer.from(JSON.stringify(buildTree(rows)), 'utf8'), empty: false }
}

// ---------------------------------------------------------------------------
// Структурные данные лендинга
// ---------------------------------------------------------------------------

// Везде только status='published' и порядок по position: черновик не должен
// попадать на сайт, а порядок карточек — это решение редактора, а не БД.
// Вторым ключом сортировки идёт id (у stats — key): position по умолчанию 0,
// и без него порядок одинаковых позиций определяется планировщиком, то есть
// может меняться от запроса к запросу.

const SQL_PROJECTS = `
  SELECT p.id, p.slug,
         m.filename AS cover_file, m.width AS cover_w, m.height AS cover_h
  FROM projects p
  LEFT JOIN media m ON m.id = p.cover_media_id AND m.deleted_at IS NULL
  WHERE p.status = 'published'
  ORDER BY p.position, p.id`

// Условие на media в JOIN, а не в WHERE: мягко удалённая обложка обязана
// превратить проект в проект без обложки, а не убрать его с сайта целиком.
const SQL_PROJECT_PHOTOS = `
  SELECT ph.project_id, m.filename, m.width, m.height
  FROM project_photos ph
  JOIN projects p ON p.id = ph.project_id
  JOIN media m ON m.id = ph.media_id AND m.deleted_at IS NULL
  WHERE p.status = 'published'
  ORDER BY ph.project_id, ph.position, m.id`

const SQL_PARTNERS = `
  SELECT pa.id, pa.name, m.filename, m.width, m.height
  FROM partners pa
  LEFT JOIN media m ON m.id = pa.media_id AND m.deleted_at IS NULL
  WHERE pa.status = 'published'
  ORDER BY pa.position, pa.id`

const SQL_ADVANTAGES = `
  SELECT a.slug, a.tone, m.filename, m.width, m.height
  FROM advantages a
  LEFT JOIN media m ON m.id = a.icon_media_id AND m.deleted_at IS NULL
  WHERE a.status = 'published'
  ORDER BY a.position, a.id`

// У stats нет status: цифр всего несколько, и «скрыть» одну из них означает
// удалить строку.
const SQL_STATS = 'SELECT key, value, tone, hero_slot FROM stats ORDER BY position, key'

const SQL_PHONES = `SELECT e164 FROM phones WHERE status = 'published' ORDER BY position, id`

/**
 * Ссылка на файл плюс размеры. Размеры отдаются всегда и для всех картинок:
 * без width/height у <img> браузер не знает пропорций до загрузки, и страница
 * дёргается по мере подгрузки (CLS).
 *
 * encodeURIComponent, хотя имена файлов генерируем мы сами и они состоят из
 * hex и расширения: URL собирается из данных базы, и одно кривое имя не должно
 * превращаться в битую ссылку или в лишний сегмент пути.
 */
const mediaOf = (filename, width, height) => {
  if (!filename) return null
  return {
    url: `${MEDIA_URL_PREFIX}${encodeURIComponent(filename)}`,
    w: width ?? null,
    h: height ?? null,
  }
}

// Число в начале строки и всё остальное хвостом.
//
// Пробел внутри числа — это разделитель разрядов ('1 200 м²'), поэтому одиночный
// пробел между цифрами входит в само число. Отсюда '(?:\s?\d)': пробел
// засчитывается только вместе со следующей за ним цифрой, иначе шаблон съел бы
// и пробел ПЕРЕД единицами измерения, а '1 200 м²' превратилось бы в 1.
// Неразрывный пробел (его приносят копированием из вёрстки) в JavaScript
// попадает под \s, отдельной ветки под него не нужно.
//
// Пробел между числом и хвостом НЕ съедаем: '450 м²' и '450+' форматируются
// по-разному, и это решение редактора, а не наше.
const STAT_VALUE_PATTERN = /^\s*(\d(?:\s?\d)*(?:[.,]\d+)?)(.*)$/

/**
 * stats.value хранится готовой к показу строкой ('53', '100+', '24/7'), потому
 * что в ней бывают знаки и единицы. Фронту же нужен отдельный числовой конец:
 * счётчик на первом экране анимирует значение от нуля, а суффикс просто
 * дописывает. Если числа в начале нет — value null, и фронт покажет строку
 * целиком как суффикс, без анимации.
 */
const splitStatValue = (raw) => {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  const match = STAT_VALUE_PATTERN.exec(text)
  if (!match) return { value: null, suffix: text.trim() }
  // Разделители разрядов убираем, запятая как десятичный разделитель
  // приходит из русской раскладки.
  const digits = match[1].replace(/\s/g, '').replace(',', '.')
  return { value: Number(digits), suffix: match[2].trimEnd() }
}

/**
 * Устойчивый ключ партнёра. В таблице partners slug'а нет — логотип
 * идентифицируется id, — но фронту нужен читаемый ключ списка, поэтому он
 * выводится из названия. Название редактируемое и может быть нелатинским,
 * поэтому пустой результат и повтор закрываются номером строки: ключ обязан
 * быть уникальным в пределах ответа, иначе React перепутает карточки местами.
 */
const partnerSlug = (name, id, used) => {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

  const slug = base && !used.has(base) ? base : `partner-${id}`
  used.add(slug)
  return slug
}

/**
 * Весь структурный контент одним объектом. Порядок ключей фиксирован кодом,
 * а не выборкой, поэтому одинаковые данные всегда дают байт в байт одинаковый
 * JSON — иначе ETag менялся бы на пустом месте и обесценивал кэш.
 */
const buildSiteContent = (db) => {
  const projects = db.all(SQL_PROJECTS)
  // Один снимок настроек на весь ответ: форма и SEO обязаны быть собраны
  // из одной ревизии таблицы, иначе тело ответа склеилось бы из двух.
  const settings = settingsSnapshot(db).values

  // Фотографии одним запросом на все проекты, а не по запросу на проект:
  // проектов десяток, и N+1 здесь превратился бы в десяток обращений к базе
  // ради ответа, который всё равно кэшируется целиком.
  const photosByProject = new Map()
  for (const row of db.all(SQL_PROJECT_PHOTOS)) {
    const photo = mediaOf(row.filename, row.width, row.height)
    const list = photosByProject.get(row.project_id)
    if (list) list.push(photo)
    else photosByProject.set(row.project_id, [photo])
  }

  const usedPartnerSlugs = new Set()

  return {
    projects: projects.map((row) => ({
      slug: row.slug,
      cover: mediaOf(row.cover_file, row.cover_w, row.cover_h),
      photos: photosByProject.get(row.id) ?? [],
    })),
    partners: db.all(SQL_PARTNERS).map((row) => ({
      slug: partnerSlug(row.name, row.id, usedPartnerSlugs),
      name: row.name,
      logo: mediaOf(row.filename, row.width, row.height),
    })),
    advantages: db.all(SQL_ADVANTAGES).map((row) => ({
      slug: row.slug,
      tone: row.tone,
      icon: mediaOf(row.filename, row.width, row.height),
    })),
    stats: db.all(SQL_STATS).map((row) => ({
      slug: row.key,
      ...splitStatValue(row.value),
      tone: row.tone,
      heroSlot: row.hero_slot ?? null,
    })),
    phones: db.all(SQL_PHONES).map((row) => row.e164),
    form: {
      requireMessage: Boolean(settings[SETTING_KEYS.FORM_REQUIRE_MESSAGE]),
    },
    seo: {
      title: settings[SETTING_KEYS.SEO_TITLE] || '',
      description: settings[SETTING_KEYS.SEO_DESCRIPTION] || '',
      ogImage: settings[SETTING_KEYS.SEO_OG_IMAGE] || '',
    },
  }
}

// ---------------------------------------------------------------------------
// Кэш ответов
// ---------------------------------------------------------------------------

const SQL_GENERATION = `SELECT value FROM app_state WHERE key = 'content_generation'`

/**
 * Хранилище готовых ответов процесса.
 *
 * Ключей ровно шесть (пять языков и структурный контент), все из закрытого
 * списка, поэтому вытеснение не нужно: Map не может вырасти от запросов
 * снаружи. Тела маленькие — десятки килобайт на процесс.
 */
export const createContentStore = (
  db,
  {
    generationTtlMs = GENERATION_TTL_MS,
    // CR-046. После неудачной пересборки не долбим базу на каждом запросе:
    // под нагрузкой сбой SQLite превращался в сотни одинаковых падающих
    // запросов в секунду, что мешало базе восстановиться. Пауза растёт
    // до максимума и сбрасывается первым успехом.
    failureBackoffMs = 1_000,
    maxFailureBackoffMs = 30_000,
    // Ключей всего шесть и все из закрытого списка, но ограничение размера
    // задано явно: без него любая будущая параметризация ключа превращает
    // кэш в неограниченный рост памяти по запросу снаружи.
    maxEntries = 32,
    now = () => Date.now(),
  } = {}
) => {
  const cache = new Map()
  // Один общий промис пересборки на ключ. Без него N параллельных запросов
  // за одним и тем же языком запускали N одинаковых чтений базы.
  const inFlight = new Map()
  const failures = new Map()

  const metrics = {
    hit: 0,
    miss: 0,
    rebuild: 0,
    coalesced: 0,
    staleServed: 0,
    error: 0,
    backoffSkipped: 0,
  }

  let generation = null
  let generationCheckedAt = 0

  /**
   * Номер ревизии контента. Читается из базы не чаще раза в GENERATION_TTL_MS —
   * подробности в шапке файла. При сбое чтения держим прошлое значение: кэш
   * останется прежним, то есть сайт продолжит отвечать тем, что уже собрано.
   */
  const currentGeneration = () => {
    const at = now()
    if (generation !== null && at - generationCheckedAt < generationTtlMs) {
      return { ok: true, value: generation }
    }

    generationCheckedAt = at
    try {
      const row = db.get(SQL_GENERATION)
      // Значение уезжает в заголовок ETag, поэтому от него оставляем только
      // буквы и цифры: кавычка или перевод строки в заголовке — это уже
      // расщепление ответа, а не косметика. Пустая строка и отсутствие
      // записи (сид не запускали) означают нулевую ревизию.
      const raw = String(row?.value ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 32)
      generation = raw || '0'
      return { ok: true, value: generation }
    } catch (error) {
      console.error(`[content] чтение content_generation не удалось: ${error.message}`)
      return { ok: false, value: generation }
    }
  }

  // Со скольких подряд идущих сбоев начинается пауза. Единица означала бы,
  // что один случайный сбой чтения задерживает возврат к нормальной работе,
  // хотя база к следующему запросу уже отвечает.
  const FAILURES_BEFORE_BACKOFF = 2

  const noteFailure = (key, gen) => {
    const previous = failures.get(key)
    const sameGeneration = previous && previous.generation === gen
    const count = sameGeneration ? previous.count + 1 : 1
    const delay = sameGeneration
      ? Math.min(previous.delay * 2, maxFailureBackoffMs)
      : failureBackoffMs
    failures.set(key, { count, delay, until: now() + delay, generation: gen })
    metrics.error += 1
  }

  /**
   * Пауза перед следующей пересборкой.
   *
   * Два ограничения делают её безопасной. Во-первых, она включается только со
   * второго подряд сбоя: от одиночного шторма запросов защищает single-flight,
   * а пауза нужна против устойчивого отказа базы. Во-вторых, она действует
   * внутри одной ревизии контента — номер ревизии читается из той же SQLite,
   * и если он прочитался и изменился, база демонстративно жива, а новая
   * ревизия опубликована.
   */
  const backoffActive = (key, gen) => {
    const state = failures.get(key)
    if (!state) return false
    if (state.generation !== gen) return false
    if (state.count < FAILURES_BEFORE_BACKOFF) return false
    return now() < state.until
  }

  const remember = (key, entry) => {
    cache.set(key, entry)
    // Ограничение размера — вытесняем самый старый ключ. Map хранит порядок
    // вставки, поэтому отдельная структура не нужна.
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /**
   * Готовая запись кэша либо null, если собрать ответ не из чего.
   *
   * @param {string} key ключ кэша
   * @param {() => Promise<{ok:boolean, body:Buffer|null}>|{ok:boolean, body:Buffer|null}} build
   * @param {{fallback?: () => Promise<Buffer|null>|Buffer|null}} options
   */
  const entryFor = async (key, build, { fallback } = {}) => {
    const cached = cache.get(key)
    const generationResult = currentGeneration()

    const degraded = async (reason) => {
      console.error(`[content] degraded response "${key}": ${reason}`)
      if (cached) {
        metrics.staleServed += 1
        return { ...cached, degraded: true }
      }
      const body = typeof fallback === 'function' ? await fallback() : null
      if (!body) return null
      // Не кладём fallback в cache: восстановившаяся БД должна быть прочитана
      // уже на следующем запросе, а fallback не получает новую DB revision.
      return {
        generation: 'fallback',
        body,
        etag: etagFor('fallback', body),
        degraded: true,
      }
    }

    // Сбой чтения ревизии в backoff не уводим: currentGeneration() и так
    // ходит в базу не чаще раза в GENERATION_TTL_MS, а лишняя пауза здесь
    // задержала бы возврат к нормальной работе после восстановления базы.
    if (!generationResult.ok) return degraded('generation_read_failed')
    const gen = generationResult.value
    if (cached && cached.generation === gen) {
      metrics.hit += 1
      return cached
    }

    metrics.miss += 1

    // Пауза после недавнего сбоя: отдаём последнее валидное состояние, не
    // трогая базу. Ревизия кэша при этом НЕ продвигается.
    if (backoffActive(key, gen)) {
      metrics.backoffSkipped += 1
      return degraded('rebuild_backoff')
    }

    // Single-flight: параллельные запросы за одним ключом ждут одну пересборку.
    const running = inFlight.get(key)
    if (running) {
      metrics.coalesced += 1
      return running
    }

    const rebuild = (async () => {
      metrics.rebuild += 1
      try {
        const result = await build()
        if (!result?.ok) {
          noteFailure(key, gen)
          return await degraded('database_read_failed')
        }
        if (result.body) {
          const entry = { generation: gen, body: result.body, etag: etagFor(gen, result.body) }
          remember(key, entry)
          failures.delete(key)
          return entry
        }
        // Пустой результат — это не сбой: контента действительно нет.
        // Ревизию в этом случае не публикуем и в backoff не уходим.
        return await degraded('empty_content')
      } catch (error) {
        console.error(`[content] сборка ответа "${key}" не удалась: ${error.message}`)
        noteFailure(key, gen)
        // Пересборка не удалась — отдаём прошлый ответ, если он есть.
        // Устаревший текст лендинга лучше пустой страницы, а ETag у такой
        // записи остаётся от старой ревизии, поэтому клиент вернётся
        // за свежей на следующем запросе.
        return await degraded('response_build_failed')
      } finally {
        inFlight.delete(key)
      }
    })()

    inFlight.set(key, rebuild)
    return rebuild
  }

  return { entryFor, metrics: () => ({ ...metrics }) }
}

// ---------------------------------------------------------------------------
// Обработчики
// ---------------------------------------------------------------------------

const localesHandler = (ctx) => async (req, res, params) => {
  // Регистр приводим сами: i18next присылает 'ru', но адрес могут открыть
  // руками, и отвечать 404 на /locales/RU/... незачем. На выбор строки в SQL
  // это не влияет — дальше идёт проверка по списку.
  const lng = typeof params?.lng === 'string' ? params.lng.toLowerCase() : ''
  if (!LOCALES.has(lng)) {
    apiNotFound(res)
    return
  }

  const entry = await ctx.store.entryFor(
    `locale:${lng}`,
    () => buildLocaleBody(ctx.db, lng),
    { fallback: () => readLocaleFile(lng) }
  )
  // Ни строк в базе, ни файла в сборке — отвечать нечем.
  if (!entry) {
    apiNotFound(res)
    return
  }

  sendEntry(req, res, entry)
}

const siteContentHandler = (ctx) => async (req, res) => {
  const entry = await ctx.store.entryFor('site', () => ({
    ok: true,
    body: Buffer.from(JSON.stringify(buildSiteContent(ctx.db)), 'utf8'),
  }))

  // Ни свежего ответа, ни прошлого: база недоступна. Именно 503, а не 404 —
  // маршрут существует, дело во временном сбое, и клиенту (как и мониторингу)
  // важно различать «контента нет» и «сервер не смог его собрать». json()
  // поставит no-store, чтобы ошибку не закэшировали на минуту вперёд.
  if (!entry) {
    json(res, 503, { ok: false, error: 'content_unavailable' })
    return
  }

  sendEntry(req, res, entry)
}

// ---------------------------------------------------------------------------
// Регистрация маршрутов
// ---------------------------------------------------------------------------

/**
 * Вешает публичные маршруты контента.
 *
 * Отдельный роутер для API нужен потому, что server/app.js разводит /api/*
 * и остальные пути по разным наборам маршрутов: промах по /api/* обязан
 * отдать JSON, а промах по публичному пути — оболочку SPA. Если apiRouter
 * не передан, оба маршрута регистрируются на одном роутере — так удобно
 * в тестах, где набор один.
 *
 * HEAD отдельно не регистрируется: его обслуживает обработчик GET
 * (см. match() в server/router.js), тело отрезает sendEntry.
 *
 * @param {{register: Function}} router публичный роутер
 * @param {{db: object, apiRouter?: {register: Function}}} deps
 */
export const registerPublicContentRoutes = (router, deps = {}) => {
  const { db, apiRouter } = deps
  if (!db) throw new TypeError('public.content: нужен deps.db')

  // Кэш общий на оба маршрута: у них одно поколение контента и один цикл
  // инвалидации, а два независимых хранилища расходились бы во времени.
  const ctx = { db, store: createContentStore(db) }

  router.register('GET', '/locales/:lng/translation.json', localesHandler(ctx))

  const api = apiRouter ?? router
  api.register('GET', '/api/site/content', siteContentHandler(ctx))

  return router
}
