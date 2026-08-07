// Перенос контента лендинга из файлов репозитория в базу.
//
// ЗАЧЕМ. До админки единственным источником текстов были public/locales/*.json,
// а структур (проекты, партнёры, цифры, телефоны) — src/data/content.js.
// Дальше правит человек через админку, и оба файла перестают быть правдой.
// Этот скрипт переносит их содержимое в SQLite один раз и доказывает, что
// перенос ничего не потерял.
//
// ПОЧЕМУ ЛИТЕРАЛЫ СКОПИРОВАНЫ, А НЕ ИМПОРТИРОВАНЫ. src/data/content.js
// импортирует .webp — это работает только внутри сборки Vite, у Node такого
// загрузчика нет, и import упал бы на первой же строке. Копия ниже защищена
// ассертами: количество элементов и совпадение slug'ов с ключами локалей.
// Разошлись — скрипт останавливается с объяснением, а не заводит сущность,
// у которой нигде нет ни названия, ни описания.
//
// ПОЧЕМУ ru ЗАЛИВАЕТСЯ КАК source='manual', А ОСТАЛЬНЫЕ КАК 'imported',
// И ВСЕ С is_locked=1 И ЗАПОЛНЕННЫМ source_hash. source_hash хранит хеш
// РУССКОГО текста, с которого сделан перевод. Совпадение хешей означает
// «перевод соответствует текущему исходнику», поэтому после переезда очередь
// автоперевода пуста: первое же сохранение русского текста без изменений
// не поставит ни одной задачи и не потратит квоту DeepL. is_locked=1 говорит,
// что переводы выверены руками (они и есть выверенные — их писал человек),
// и автоперевод не имеет права их перетереть.
//
// ЗАПУСК из корня проекта (относительный DATA_DIR резолвится от рабочего
// каталога, иначе получится вторая, пустая база):
//
//   node scripts/seed-content.mjs --dry-run
//   node scripts/seed-content.mjs
//   node scripts/seed-content.mjs --force

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { config } from '../server/config.js'
import { closeDb, getDb, DB_FILENAME } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrate.js'
import { contentAddressedName, sniffImage } from '../server/lib/image.js'

const ROOT = join(import.meta.dirname, '..')
const LOCALES_DIR = join(ROOT, 'public', 'locales')
const DESIGN_DIR = join(ROOT, 'src', 'assets', 'design')
// Тот же каталог, из которого server/app.js отдаёт /media/*.
const MEDIA_DIR = join(config.dataDir, 'media')

// Порядок важен только для отчёта; ru первым, потому что от него считаются
// хеши остальных.
const LOCALES = ['ru', 'en', 'uz', 'tr', 'ar']
const SOURCE_LOCALE = 'ru'

// Шаг между позициями. Единичный шаг заставил бы перенумеровывать весь список
// ради одной вставки в середину, а с шагом 10 между соседями есть место.
const POSITION_STEP = 10

// ---------------------------------------------------------------------------
// Блок seed: копия структур из src/data/content.js
// ---------------------------------------------------------------------------
//
// Правило переноса: ключ структуры = slug в базе = сегмент ключа локали.
// icon/cover/photos/file — имена файлов в src/assets/design, ровно те же,
// что импортирует content.js.

const SEED = {
  // ADVANTAGES: тексты лежат под services.<slug>.{title,desc}.
  advantages: [
    { slug: 'consult', icon: 'adv-1.webp', tone: 'cold' },
    { slug: 'equipment', icon: 'adv-2.webp', tone: 'cold' },
    { slug: 'install', icon: 'adv-3.webp', tone: 'warm' },
    { slug: 'team', icon: 'adv-4.webp', tone: 'warm' },
  ],

  // STATS: подписи лежат под ratings.<key>. value — TEXT, потому что колонка
  // хранит готовую к показу строку; сейчас это чистые числа из content.js.
  // heroSlot взят из src/components/Hero.jsx, где те же цифры выводятся
  // в первом экране в порядке fact1..fact3 (53+, 50+, 20+); «специализированное
  // оборудование» в hero не показывается, поэтому слота у него нет.
  stats: [
    { key: 'staff', value: '50', tone: 'cold', heroSlot: 2 },
    { key: 'objects', value: '53', tone: 'cold', heroSlot: 1 },
    { key: 'equipment', value: '100', tone: 'warm', heroSlot: null },
    { key: 'years', value: '20', tone: 'warm', heroSlot: 3 },
  ],

  // PROJECTS: тексты лежат под projects.<slug>.{tag,title,card,desc}.
  projects: [
    { slug: 'caex', cover: 'pr-1.webp', photos: ['pr-1.webp', 'w3.webp', 'roof-units.webp', 'w1.webp'] },
    { slug: 'opera', cover: 'pr-2.webp', photos: ['pr-2.webp', 'opera-ext.webp', 'facade-units.webp', 'crew-roof.webp'] },
    { slug: 'ramada', cover: 'pr-3.webp', photos: ['pr-3.webp', 'boiler-ferroli.webp', 'w5.webp', 'w2.webp'] },
    { slug: 'school', cover: 'pr-4.webp', photos: ['pr-4.webp', 'w1.webp', 'w4.webp', 'w3.webp'] },
    { slug: 'yurt', cover: 'pr-5.webp', photos: ['pr-5.webp', 'roof-units.webp', 'w5.webp', 'w2.webp'] },
    { slug: 'renaissance', cover: 'pr-6.webp', photos: ['pr-6.webp', 'facade-units.webp', 'w4.webp', 'boiler-ferroli.webp'] },
  ],

  // PARTNERS: название — это данные, а не ключ перевода, поэтому лежит прямо
  // в таблице. Логотип Mitsubishi единственный в SVG: в media он не попадёт
  // (см. server/lib/image.js — SVG это исполняемый XML, то есть хранимый XSS),
  // строка партнёра создаётся без картинки и об этом сказано в отчёте.
  partners: [
    { name: 'Shivaki', file: 'br-shivaki.webp' },
    { name: 'AUX', file: 'br-aux.webp' },
    { name: 'Toshiba', file: 'br-toshiba.webp' },
    { name: 'Hisense', file: 'br-hisense.webp' },
    { name: 'Mitsubishi Electric', file: 'br-mitsubishi.svg' },
    { name: 'AKFA Build', file: 'br-akfa.webp' },
    { name: 'KOC Construction', file: 'br-koc.webp' },
    { name: 'Discover Invest', file: 'br-discover.webp' },
  ],

  // PHONES: строго E.164, из этого вида собираются и tel:, и человеческий формат.
  phones: ['+998998555045', '+998998956568', '+998909161020'],
}

// Ожидаемые размеры набора. Дублируют длину массивов намеренно: если кто-то
// добавит проект в src/data/content.js и скопирует его сюда, не поправив число,
// он остановится на этой проверке и заодно вспомнит про переводы.
const EXPECTED = { projects: 6, partners: 8, advantages: 4, stats: 4, phones: 3 }

// ---------------------------------------------------------------------------
// Вывод
// ---------------------------------------------------------------------------

const out = (line = '') => process.stdout.write(`${line}\n`)
// Служебное — в stderr, чтобы stdout оставался отчётом.
const note = (line = '') => process.stderr.write(`${line}\n`)

/** Ошибка употребления: печатаем справку и выходим с кодом 2. */
class UsageError extends Error {}
/** Расхождение при финальной сверке. Откатывает транзакцию. */
class VerificationError extends Error {}
/** Сигнал отката для --dry-run. Не ошибка, поэтому отдельный класс. */
class DryRunRollback extends Error {}

const usage = () => `Перенос контента лендинга в базу.

  node scripts/seed-content.mjs [--dry-run] [--force]

  --dry-run  выполнить всё, включая сверку, и откатить транзакцию.
             Файлы медиа при этом на диск не копируются, но схема базы
             при необходимости накатывается (без неё нечего проверять).
  --force    перезаписать уже существующие записи. По умолчанию всё, что
             в базе уже есть, остаётся нетронутым.
  --help     эта справка

Источники: public/locales/{${LOCALES.join(',')}}/translation.json,
           структуры из src/data/content.js (копия внутри скрипта),
           src/assets/design/*.webp

База:  ${join(config.dataDir, DB_FILENAME)}
Медиа: ${MEDIA_DIR}
`

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(['dry-run', 'force', 'help'])

const parseArgs = (argv) => {
  const flags = new Set()
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new UsageError(`лишний аргумент "${arg}"`)
    const name = arg.slice(2)
    if (!KNOWN_FLAGS.has(name)) throw new UsageError(`неизвестный флаг "--${name}"`)
    flags.add(name)
  }
  return flags
}

// ---------------------------------------------------------------------------
// Локали: чтение, расплющивание, сборка обратно
// ---------------------------------------------------------------------------

/**
 * Хеш исходного (русского) текста для content_entries.source_hash.
 *
 * Определение обязано совпадать с тем, что считает очередь автоперевода:
 * это sha256 в нижнем регистре hex от UTF-8 байт значения БЕЗ какой-либо
 * нормализации (пробелы, регистр и юникод-форма остаются как есть). Любое
 * расхождение в определении сделает все 364 перевода «устаревшими» и при
 * первом же сохранении отправит их в DeepL.
 */
const hashSource = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

// Сегмент, который JS считает индексом массива. Такой ключ в объекте всегда
// всплывает наверх независимо от порядка вставки, то есть «порядок как в файле»
// перестал бы существовать молча. В текущих локалях таких нет — проверка стоит
// на будущее.
const INTEGER_LIKE = /^(?:0|[1-9][0-9]*)$/

/**
 * Расплющивает дерево локали в массив пар [dot-путь, строка].
 * Порядок пар — порядок следования ключей в файле.
 */
const flattenTree = (node, locale, prefix = '', out = []) => {
  for (const [segment, value] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${segment}` : segment

    if (!segment) throw new Error(`[${locale}] пустой сегмент ключа рядом с "${prefix}"`)
    if (segment.includes('.')) {
      throw new Error(`[${locale}] сегмент "${segment}" содержит точку: dot-путь "${key}" ` +
        'нельзя разобрать обратно однозначно')
    }
    if (INTEGER_LIKE.test(segment)) {
      throw new Error(`[${locale}] сегмент "${segment}" — целое число: такой ключ JS ставит ` +
        'первым в объекте, и порядок ключей в файле перестаёт что-либо значить')
    }

    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        throw new Error(`[${locale}] ключ "${key}" — массив, а content_entries хранит строки`)
      }
      flattenTree(value, locale, key, out)
      continue
    }

    if (typeof value !== 'string') {
      throw new Error(`[${locale}] ключ "${key}" имеет тип ${typeof value}, ожидалась строка`)
    }
    // Колонка value объявлена NOT NULL, но пустая строка ей не противоречит,
    // а на сайте это пустая кнопка или пустой заголовок.
    if (!value) throw new Error(`[${locale}] ключ "${key}" пустой`)

    out.push([key, value])
  }
  return out
}

/** Собирает дерево обратно из пар. Ловит конфликт «лист против ветки». */
const unflatten = (pairs, label) => {
  const root = {}

  for (const [key, value] of pairs) {
    const segments = key.split('.')
    let node = root

    for (let i = 0; i < segments.length - 1; i += 1) {
      const branch = segments.slice(0, i + 1).join('.')
      const next = node[segments[i]]
      if (next === undefined) {
        node[segments[i]] = {}
      } else if (typeof next !== 'object') {
        throw new Error(`[${label}] ключ "${key}" не собирается: по пути "${branch}" уже лежит строка`)
      }
      node = node[segments[i]]
    }

    const leaf = segments.at(-1)
    if (node[leaf] !== undefined) {
      throw new Error(`[${label}] ключ "${key}" встречается дважды или перекрыт веткой`)
    }
    node[leaf] = value
  }

  return root
}

/**
 * Каноническая запись дерева: ключи отсортированы на всех уровнях, отступ
 * фиксирован. Порядок ключей в content_entries не хранится (первичный ключ
 * (locale, key) и так задаёт свой), поэтому сравнивать «файл против базы»
 * можно только после приведения обеих сторон к одному порядку.
 */
const canonical = (node) => {
  if (node === null || typeof node !== 'object') return node
  const sorted = {}
  for (const key of Object.keys(node).sort()) sorted[key] = canonical(node[key])
  return sorted
}

const normalize = (tree) => JSON.stringify(canonical(tree), null, 2)

const readLocale = (locale) => {
  const path = join(LOCALES_DIR, locale, 'translation.json')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`не читается ${path}: ${error.code ?? error.message}`, { cause: error })
  }

  let tree
  try {
    tree = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} — битый JSON: ${error.message}`, { cause: error })
  }
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    throw new Error(`${path} должен содержать объект`)
  }

  return { locale, path, tree, pairs: flattenTree(tree, locale) }
}

/**
 * Читает все локали и проверяет, что наборы ключей совпадают. Проверка не
 * формальность: недостающий ключ в одном языке — это дыра в интерфейсе,
 * а лишний — текст, которого нет в исходнике и который некому обновлять.
 */
const readAllLocales = () => {
  const loaded = LOCALES.map(readLocale)
  const source = loaded[0]
  if (source.locale !== SOURCE_LOCALE) {
    throw new Error(`первым в LOCALES должен идти ${SOURCE_LOCALE}`)
  }

  const expected = source.pairs.map(([key]) => key)
  const expectedSet = new Set(expected)

  for (const locale of loaded.slice(1)) {
    const actualSet = new Set(locale.pairs.map(([key]) => key))
    const missing = expected.filter((key) => !actualSet.has(key))
    const extra = [...actualSet].filter((key) => !expectedSet.has(key))
    if (missing.length || extra.length) {
      throw new Error(
        `набор ключей ${locale.locale} не совпадает с ${SOURCE_LOCALE}:` +
        (missing.length ? `\n  нет в ${locale.locale}: ${missing.join(', ')}` : '') +
        (extra.length ? `\n  лишние в ${locale.locale}: ${extra.join(', ')}` : '')
      )
    }
  }

  return loaded
}

// ---------------------------------------------------------------------------
// Сверка блока seed с ключами локалей
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const STAT_KEY_PATTERN = /^[a-z0-9_]+$/
const E164_PATTERN = /^\+[0-9]{7,15}$/

/** Прямые потомки узла prefix, у которых есть собственные дети. */
const childBranches = (keys, prefix) => {
  const found = new Set()
  for (const key of keys) {
    if (!key.startsWith(`${prefix}.`)) continue
    const rest = key.slice(prefix.length + 1)
    const dot = rest.indexOf('.')
    if (dot > 0) found.add(rest.slice(0, dot))
  }
  return found
}

/** Прямые потомки-листья узла prefix. */
const childLeaves = (keys, prefix) => {
  const found = new Set()
  for (const key of keys) {
    if (!key.startsWith(`${prefix}.`)) continue
    const rest = key.slice(prefix.length + 1)
    if (!rest.includes('.')) found.add(rest)
  }
  return found
}

const sameSets = (label, expected, actual, problems) => {
  const missing = [...expected].filter((item) => !actual.has(item))
  const extra = [...actual].filter((item) => !expected.has(item))
  if (missing.length) problems.push(`${label}: нет в локалях — ${missing.join(', ')}`)
  if (extra.length) problems.push(`${label}: есть в локалях, но нет в блоке seed — ${extra.join(', ')}`)
}

const assertUnique = (label, values, problems) => {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) problems.push(`${label}: значение "${value}" повторяется`)
    seen.add(value)
  }
}

/**
 * Главная защита от тихого расхождения копии с оригиналом. Проверяется
 * и количество, и то, что каждому slug'у соответствуют ключи локалей,
 * и обратное — что в локалях нет slug'ов, которых нет в блоке seed.
 */
const assertSeedMatchesLocales = (sourcePairs) => {
  const keys = sourcePairs.map(([key]) => key)
  const keySet = new Set(keys)
  const problems = []

  for (const [name, count] of Object.entries(EXPECTED)) {
    const actual = SEED[name].length
    if (actual !== count) problems.push(`${name}: ожидалось ${count} элементов, в блоке seed ${actual}`)
  }

  const projectSlugs = SEED.projects.map((item) => item.slug)
  const advantageSlugs = SEED.advantages.map((item) => item.slug)
  const statKeys = SEED.stats.map((item) => item.key)

  assertUnique('projects.slug', projectSlugs, problems)
  assertUnique('advantages.slug', advantageSlugs, problems)
  assertUnique('stats.key', statKeys, problems)
  assertUnique('partners.name', SEED.partners.map((item) => item.name), problems)
  assertUnique('phones', SEED.phones, problems)

  for (const slug of [...projectSlugs, ...advantageSlugs]) {
    if (!SLUG_PATTERN.test(slug)) {
      problems.push(`slug "${slug}" не проходит CHECK таблицы: [a-z0-9][a-z0-9-]{1,63}`)
    }
  }
  for (const key of statKeys) {
    if (!STAT_KEY_PATTERN.test(key)) problems.push(`stats.key "${key}" допускает только [a-z0-9_]`)
  }
  for (const phone of SEED.phones) {
    if (!E164_PATTERN.test(phone)) problems.push(`телефон "${phone}" не в формате E.164`)
  }

  // Проекту нужны все четыре текста: без tag/card карточка пустая, без desc
  // пуста страница проекта.
  for (const slug of projectSlugs) {
    for (const field of ['tag', 'title', 'card', 'desc']) {
      const key = `projects.${slug}.${field}`
      if (!keySet.has(key)) problems.push(`проект "${slug}": в локалях нет ключа ${key}`)
    }
  }
  for (const slug of advantageSlugs) {
    for (const field of ['title', 'desc']) {
      const key = `services.${slug}.${field}`
      if (!keySet.has(key)) problems.push(`преимущество "${slug}": в локалях нет ключа ${key}`)
    }
  }
  for (const key of statKeys) {
    if (!keySet.has(`ratings.${key}`)) problems.push(`цифра "${key}": в локалях нет ключа ratings.${key}`)
  }

  // Обратная сторона: ветка projects.<x> без строки в базе — это текст,
  // который никогда не покажется, потому что показывать его нечему.
  sameSets('projects', new Set(projectSlugs), childBranches(keys, 'projects'), problems)
  sameSets('services', new Set(advantageSlugs), childBranches(keys, 'services'), problems)
  // ratings.h2 — заголовок секции, а не подпись к цифре.
  const ratingKeys = childLeaves(keys, 'ratings')
  ratingKeys.delete('h2')
  sameSets('ratings', new Set(statKeys), ratingKeys, problems)

  if (problems.length) {
    throw new Error(
      'блок seed разошёлся с локалями (правьте scripts/seed-content.mjs ' +
      `вслед за src/data/content.js):\n  - ${problems.join('\n  - ')}`
    )
  }
}

// ---------------------------------------------------------------------------
// Медиа
// ---------------------------------------------------------------------------

/**
 * Читает src/assets/design/*.webp. Перекодирования нет намеренно: файлы уже
 * в WebP и уже нужной ширины (их готовит scripts/optimize-images.mjs), а
 * второй проход через кодек только ухудшил бы картинку и потребовал бы sharp.
 * Размеры разбираются по заголовку — тем же кодом, что проверяет загрузки
 * из админки, поэтому битый файл обнаружится здесь, а не в браузере.
 */
const collectMedia = () => {
  let entries
  try {
    // Сортировка нужна для повторяемости: readdir возвращает файлы в порядке
    // файловой системы, и без неё id в media зависели бы от машины.
    entries = readdirSync(DESIGN_DIR).filter((name) => name.endsWith('.webp')).sort()
  } catch (error) {
    throw new Error(`каталог ассетов недоступен: ${DESIGN_DIR} (${error.code ?? error.message})`,
      { cause: error })
  }
  if (!entries.length) throw new Error(`в ${DESIGN_DIR} нет ни одного .webp`)

  const items = []
  const bySha = new Map()
  const byFile = new Map()

  for (const originalName of entries) {
    const buffer = readFileSync(join(DESIGN_DIR, originalName))
    const meta = sniffImage(buffer)
    if (!meta) throw new Error(`${originalName}: содержимое не распознано как изображение`)
    if (meta.mime !== 'image/webp') {
      throw new Error(`${originalName}: по содержимому это ${meta.mime}, а не WebP — ` +
        'переименованный файл, а не сконвертированный')
    }

    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const duplicate = bySha.get(sha256)
    if (duplicate) {
      // Одинаковое содержимое — одна запись в media и один файл на диске:
      // колонки sha256 и filename объявлены UNIQUE, да и 500 МБ на всё.
      byFile.set(originalName, duplicate)
      continue
    }

    const item = {
      originalName,
      buffer,
      sha256,
      filename: contentAddressedName(buffer, meta.mime),
      mime: meta.mime,
      width: meta.width,
      height: meta.height,
      bytes: buffer.length,
      // Заполняется при записи в базу.
      id: null,
    }
    items.push(item)
    bySha.set(sha256, item)
    byFile.set(originalName, item)
  }

  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)
  if (totalBytes > config.mediaQuotaBytes) {
    throw new Error(
      `ассеты занимают ${(totalBytes / 1048576).toFixed(2)} МБ при квоте ` +
      `${(config.mediaQuotaBytes / 1048576).toFixed(2)} МБ (MEDIA_QUOTA_BYTES)`
    )
  }

  return { items, byFile, totalBytes }
}

/** Проверяет, что каждый файл, на который ссылается блок seed, существует. */
const assertSeedFiles = (byFile) => {
  const problems = []
  const check = (label, name) => {
    if (!name) return
    if (byFile.has(name)) return
    if (existsSync(join(DESIGN_DIR, name))) {
      // Не .webp — например, SVG. Это не ошибка данных, а осознанное
      // отсутствие картинки; ругаться будем только на пропавший файл.
      return
    }
    problems.push(`${label}: файл src/assets/design/${name} не найден`)
  }

  for (const item of SEED.advantages) check(`преимущество "${item.slug}"`, item.icon)
  for (const item of SEED.projects) {
    check(`проект "${item.slug}" (обложка)`, item.cover)
    for (const photo of item.photos) check(`проект "${item.slug}" (фото)`, photo)
  }
  for (const item of SEED.partners) check(`партнёр "${item.name}"`, item.file)

  if (problems.length) throw new Error(`ассеты не найдены:\n  - ${problems.join('\n  - ')}`)
}

/**
 * Копирует файлы в DATA_DIR/media. Делается ДО транзакции: строка в media
 * не должна появиться раньше файла, на который она ссылается.
 *
 * Имя содержит хеш содержимого, поэтому уже лежащий файл с таким именем —
 * это ровно тот же файл, и перезаписывать его незачем. По той же причине
 * безобиден откат транзакции: осиротевшие файлы переиспользует следующий
 * запуск, а не найдёт их уборщик медиа.
 */
const writeMediaFiles = (items) => {
  mkdirSync(MEDIA_DIR, { recursive: true })

  let written = 0
  for (const item of items) {
    const target = join(MEDIA_DIR, item.filename)
    if (existsSync(target)) continue
    writeFileSync(target, item.buffer)
    written += 1
  }
  return written
}

// ---------------------------------------------------------------------------
// Запись в базу
// ---------------------------------------------------------------------------

const SQL_INSERT_ENTRY = `
  INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash, updated_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)
`

const SQL_UPDATE_ENTRY = `
  UPDATE content_entries
     SET value = ?, source = ?, is_locked = 1, source_hash = ?,
         provider = NULL, translated_at = NULL, updated_at = ?
   WHERE locale = ? AND key = ?
`

/**
 * Заливает тексты. provider и translated_at остаются пустыми осознанно:
 * ни один из этих текстов не пришёл от провайдера перевода, и приписывать
 * им машинное происхождение значило бы соврать в админке.
 */
const seedEntries = (db, locales, { force, now }) => {
  const source = locales[0]
  const hashes = new Map(source.pairs.map(([key, value]) => [key, hashSource(value)]))
  const stats = new Map()

  for (const locale of locales) {
    const existing = new Set(
      db.all('SELECT key FROM content_entries WHERE locale = ?', [locale.locale]).map((row) => row.key)
    )
    const counters = { inserted: 0, updated: 0, skipped: 0 }
    const kind = locale.locale === SOURCE_LOCALE ? 'manual' : 'imported'

    for (const [key, value] of locale.pairs) {
      const sourceHash = hashes.get(key)
      if (!existing.has(key)) {
        db.run(SQL_INSERT_ENTRY, [locale.locale, key, value, kind, sourceHash, now])
        counters.inserted += 1
        continue
      }
      if (!force) {
        counters.skipped += 1
        continue
      }
      db.run(SQL_UPDATE_ENTRY, [value, kind, sourceHash, now, locale.locale, key])
      counters.updated += 1
    }

    stats.set(locale.locale, counters)
  }

  return stats
}

const seedMedia = (db, items, { force, now }) => {
  const counters = { inserted: 0, updated: 0, skipped: 0 }

  for (const item of items) {
    const existing = db.get('SELECT id FROM media WHERE sha256 = ?', [item.sha256])
    if (!existing) {
      const info = db.run(
        `INSERT INTO media (filename, original_name, mime, bytes, width, height, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.filename, item.originalName, item.mime, item.bytes, item.width, item.height,
          item.sha256, now]
      )
      item.id = Number(info.lastInsertRowid)
      counters.inserted += 1
      continue
    }

    item.id = existing.id
    if (!force) {
      counters.skipped += 1
      continue
    }
    // deleted_at сбрасываем: файл снова на диске и снова используется,
    // а мягко удалённую запись уборщик медиа однажды сотрёт вместе с файлом.
    db.run(
      `UPDATE media
          SET filename = ?, original_name = ?, mime = ?, bytes = ?, width = ?, height = ?,
              deleted_at = NULL
        WHERE id = ?`,
      [item.filename, item.originalName, item.mime, item.bytes, item.width, item.height, item.id]
    )
    counters.updated += 1
  }

  return counters
}

/** id медиа по имени файла из блока seed; null для файлов не в WebP. */
const mediaIdFor = (byFile, name) => byFile.get(name)?.id ?? null

const seedProjects = (db, byFile, { force, now }) => {
  const counters = { inserted: 0, updated: 0, skipped: 0, photos: 0 }

  SEED.projects.forEach((project, index) => {
    const position = (index + 1) * POSITION_STEP
    const cover = mediaIdFor(byFile, project.cover)
    const existing = db.get('SELECT id FROM projects WHERE slug = ?', [project.slug])

    let id
    if (!existing) {
      // status = 'published', хотя умолчание таблицы — 'hidden': это не новые
      // черновики, а проекты, которые уже показаны на сайте.
      const info = db.run(
        `INSERT INTO projects (slug, cover_media_id, position, status, created_at, updated_at)
         VALUES (?, ?, ?, 'published', ?, ?)`,
        [project.slug, cover, position, now, now]
      )
      id = Number(info.lastInsertRowid)
      counters.inserted += 1
    } else if (!force) {
      counters.skipped += 1
      return
    } else {
      id = existing.id
      db.run(
        `UPDATE projects SET cover_media_id = ?, position = ?, status = 'published', updated_at = ?
          WHERE id = ?`,
        [cover, position, now, id]
      )
      counters.updated += 1
    }

    // Галерея задаётся блоком seed целиком, поэтому проще снести и разложить
    // заново, чем вычислять разницу: лишнее фото так уходит само.
    db.run('DELETE FROM project_photos WHERE project_id = ?', [id])
    project.photos.forEach((photo, photoIndex) => {
      const mediaId = mediaIdFor(byFile, photo)
      if (mediaId == null) return
      db.run(
        `INSERT INTO project_photos (project_id, media_id, position) VALUES (?, ?, ?)
         ON CONFLICT(project_id, media_id) DO UPDATE SET position = excluded.position`,
        [id, mediaId, (photoIndex + 1) * POSITION_STEP]
      )
      counters.photos += 1
    })
  })

  return counters
}

const seedPartners = (db, byFile, { force, now }) => {
  const counters = { inserted: 0, updated: 0, skipped: 0, withoutLogo: [] }

  SEED.partners.forEach((partner, index) => {
    const position = (index + 1) * POSITION_STEP
    const mediaId = mediaIdFor(byFile, partner.file)
    if (mediaId == null) counters.withoutLogo.push(partner.name)

    // Ключ поиска — название: у partners нет ни slug, ни UNIQUE-колонки,
    // а без ключа повторный запуск создал бы восемь дублей.
    const existing = db.get('SELECT id FROM partners WHERE name = ?', [partner.name])
    if (!existing) {
      db.run(
        `INSERT INTO partners (name, media_id, url, position, status, updated_at)
         VALUES (?, ?, NULL, ?, 'published', ?)`,
        [partner.name, mediaId, position, now]
      )
      counters.inserted += 1
      return
    }
    if (!force) {
      counters.skipped += 1
      return
    }
    // url не трогаем: в исходных данных его нет, а в базе он мог появиться
    // из админки, и перезапись затёрла бы единственную ручную правку.
    db.run(
      `UPDATE partners SET media_id = ?, position = ?, status = 'published', updated_at = ?
        WHERE id = ?`,
      [mediaId, position, now, existing.id]
    )
    counters.updated += 1
  })

  return counters
}

const seedAdvantages = (db, byFile, { force }) => {
  const counters = { inserted: 0, updated: 0, skipped: 0 }

  SEED.advantages.forEach((advantage, index) => {
    const position = (index + 1) * POSITION_STEP
    const icon = mediaIdFor(byFile, advantage.icon)
    const existing = db.get('SELECT id FROM advantages WHERE slug = ?', [advantage.slug])

    if (!existing) {
      db.run(
        `INSERT INTO advantages (slug, icon_media_id, tone, position, status)
         VALUES (?, ?, ?, ?, 'published')`,
        [advantage.slug, icon, advantage.tone, position]
      )
      counters.inserted += 1
      return
    }
    if (!force) {
      counters.skipped += 1
      return
    }
    db.run(
      `UPDATE advantages SET icon_media_id = ?, tone = ?, position = ?, status = 'published'
        WHERE id = ?`,
      [icon, advantage.tone, position, existing.id]
    )
    counters.updated += 1
  })

  return counters
}

const seedStats = (db, { force, now }) => {
  const counters = { inserted: 0, updated: 0, skipped: 0 }
  const writable = []

  SEED.stats.forEach((stat, index) => {
    const existing = db.get('SELECT key FROM stats WHERE key = ?', [stat.key])
    if (existing && !force) {
      counters.skipped += 1
      return
    }
    // Новую строку от обновляемой отличаем здесь: таблица WITHOUT ROWID,
    // и lastInsertRowid после UPSERT ничего про это не скажет.
    if (existing) counters.updated += 1
    else counters.inserted += 1
    writable.push({ ...stat, position: (index + 1) * POSITION_STEP })
  })

  // Слоты снимаем отдельным проходом: на hero_slot висит частичный UNIQUE,
  // и «поменять местами первый и второй» строка за строкой упало бы
  // на промежуточном состоянии, где слот занят дважды.
  for (const stat of writable) {
    db.run('UPDATE stats SET hero_slot = NULL WHERE key = ?', [stat.key])
  }

  for (const stat of writable) {
    db.run(
      `INSERT INTO stats (key, value, tone, hero_slot, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, tone = excluded.tone, hero_slot = excluded.hero_slot,
         position = excluded.position, updated_at = excluded.updated_at`,
      [stat.key, stat.value, stat.tone, stat.heroSlot, stat.position, now]
    )
  }

  return counters
}

const seedPhones = (db, { force }) => {
  const counters = { inserted: 0, updated: 0, skipped: 0 }

  SEED.phones.forEach((e164, index) => {
    const position = (index + 1) * POSITION_STEP
    const existing = db.get('SELECT id FROM phones WHERE e164 = ?', [e164])
    if (!existing) {
      db.run(`INSERT INTO phones (e164, position, status) VALUES (?, ?, 'published')`,
        [e164, position])
      counters.inserted += 1
      return
    }
    if (!force) {
      counters.skipped += 1
      return
    }
    db.run(`UPDATE phones SET position = ?, status = 'published' WHERE id = ?`,
      [position, existing.id])
    counters.updated += 1
  })

  return counters
}

/**
 * Служебные счётчики. content_generation инвалидирует кэш и ETag выдачи
 * контента — без его увеличения браузеры и прокси показывали бы старое.
 */
const updateAppState = (db, now) => {
  const current = db.get(`SELECT value FROM app_state WHERE key = 'content_generation'`)
  const generation = Number.parseInt(current?.value ?? '0', 10)
  const next = Number.isFinite(generation) ? generation + 1 : 1

  const used = db.get('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM media WHERE deleted_at IS NULL')

  const upsert = `
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `
  db.run(upsert, ['content_generation', String(next), now])
  db.run(upsert, ['media_bytes_used', String(used.bytes), now])

  return { generation: next, mediaBytesUsed: used.bytes }
}

// ---------------------------------------------------------------------------
// Верификация
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 40

const quote = (value) => {
  const text = String(value).replace(/\s+/g, ' ')
  return text.length > 120 ? `«${text.slice(0, 117)}…»` : `«${text}»`
}

const describeDiff = (filePairs, dbRows) => {
  const fileMap = new Map(filePairs)
  const dbMap = new Map(dbRows.map((row) => [row.key, row.value]))
  const lines = []

  for (const [key, value] of fileMap) {
    if (!dbMap.has(key)) {
      lines.push(`  нет в базе    ${key}`)
      continue
    }
    const stored = dbMap.get(key)
    if (stored !== value) {
      lines.push(`  различается   ${key}`)
      lines.push(`      файл: ${quote(value)}`)
      lines.push(`      база: ${quote(stored)}`)
    }
  }
  for (const key of dbMap.keys()) {
    if (!fileMap.has(key)) lines.push(`  лишний ключ   ${key}`)
  }

  if (lines.length > MAX_DIFF_LINES) {
    const hidden = lines.length - MAX_DIFF_LINES
    return [...lines.slice(0, MAX_DIFF_LINES), `  … и ещё ${hidden} строк расхождений`]
  }
  return lines
}

/**
 * Единственное строгое доказательство, что перенос ничего не потерял:
 * для каждого языка контент собирается из базы обратно в дерево и сравнивается
 * с исходным файлом. Сравниваются канонические записи (ключи отсортированы,
 * отступ одинаковый), потому что порядок ключей в базе не хранится — но
 * значения, набор ключей и структура дерева обязаны совпасть в точности.
 */
const verify = (db, locales) => {
  const problems = []

  for (const locale of locales) {
    const rows = db.all('SELECT key, value FROM content_entries WHERE locale = ?', [locale.locale])
    const fromDb = unflatten(rows.map((row) => [row.key, row.value]), `${locale.locale}/база`)

    if (normalize(fromDb) === normalize(locale.tree)) continue

    problems.push(
      `[${locale.locale}] база разошлась с ${locale.path}:`,
      ...describeDiff(locale.pairs, rows)
    )
  }

  if (problems.length) {
    throw new VerificationError(
      `сверка не прошла, транзакция откатывается:\n${problems.join('\n')}\n\n` +
      'Если тексты в базе правили руками, перезапись требует явного --force.'
    )
  }
}

// ---------------------------------------------------------------------------
// Отчёт
// ---------------------------------------------------------------------------

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} МБ`

const changes = (counters) => {
  const parts = []
  if (counters.inserted) parts.push(`новых ${counters.inserted}`)
  if (counters.updated) parts.push(`обновлено ${counters.updated}`)
  if (counters.skipped) parts.push(`пропущено ${counters.skipped}`)
  return parts.length ? parts.join(', ') : 'без изменений'
}

const printReport = (result, { dryRun, force }) => {
  const { entries, media, projects, partners, advantages, stats, phones, state, keyCount } = result

  out('')
  out(dryRun ? 'ЧЕРНОВОЙ ПРОГОН — всё откачено, база не изменилась' : 'Перенос выполнен')
  if (force) out('Режим --force: существующие записи перезаписаны')
  out('')

  out(`Ключей в локали: ${keyCount}`)
  out(`Записей контента: ${keyCount * LOCALES.length} (${keyCount} × ${LOCALES.length} языков)`)
  for (const locale of LOCALES) {
    const counters = entries.get(locale)
    const kind = locale === SOURCE_LOCALE ? 'manual' : 'imported'
    out(`  ${locale}  ${String(keyCount).padStart(3)} ключей  source=${kind.padEnd(8)} ${changes(counters)}`)
  }
  out('')

  out(`Медиа: ${media.counters.inserted + media.counters.updated + media.counters.skipped} файлов, ` +
    `${mb(media.totalBytes)} (${changes(media.counters)})`)
  out(`  скопировано на диск: ${media.written} файлов в ${MEDIA_DIR}`)
  out(`  занято под медиа всего: ${mb(state.mediaBytesUsed)} из ${mb(config.mediaQuotaBytes)}`)
  out('')

  out('Сущности:')
  out(`  проекты      ${SEED.projects.length}  (${changes(projects)}; фотографий ${projects.photos})`)
  out(`  партнёры     ${SEED.partners.length}  (${changes(partners)})`)
  out(`  преимущества ${SEED.advantages.length}  (${changes(advantages)})`)
  out(`  цифры        ${SEED.stats.length}  (${changes(stats)})`)
  out(`  телефоны     ${SEED.phones.length}  (${changes(phones)})`)
  if (partners.withoutLogo.length) {
    out(`  без логотипа: ${partners.withoutLogo.join(', ')} — исходник в SVG, ` +
      'в media такой формат не принимается')
  }
  out('')

  out(`Ревизия контента: ${state.generation}`)
  out(`Сверка: ${LOCALES.length} языков собраны из базы и совпали с исходными файлами`)
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

const openDb = () => {
  const path = join(config.dataDir, DB_FILENAME)
  note(`[db] ${path}${existsSync(path) ? '' : ' (файла нет, будет создан)'}`)

  const db = getDb()
  const applied = runMigrations(db)
  if (applied.length) note(`[db] применены миграции: ${applied.join(', ')}`)
  return db
}

const main = async () => {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.has('help')) {
    note(usage())
    return 0
  }

  const dryRun = flags.has('dry-run')
  const force = flags.has('force')

  // Всё, что можно проверить до открытия базы, проверяется до неё: незачем
  // создавать файл базы, чтобы узнать, что в локалях разъехались ключи.
  const locales = readAllLocales()
  const source = locales[0]
  assertSeedMatchesLocales(source.pairs)

  const media = collectMedia()
  assertSeedFiles(media.byFile)
  note(`[seed] ключей ${source.pairs.length}, языков ${locales.length}, ` +
    `ассетов ${media.items.length} (${mb(media.totalBytes)})`)

  const db = openDb()
  const now = Date.now()

  // Файлы кладём на диск до транзакции: строка в media не должна ссылаться
  // на то, чего нет. В черновом прогоне не пишем ничего.
  const written = dryRun ? 0 : writeMediaFiles(media.items)

  let result = null
  try {
    db.transaction(() => {
      // Порядок полей в литерале — это порядок выполнения, и он важен:
      // media заполняет item.id, на который дальше ссылаются проекты,
      // партнёры и преимущества.
      result = {
        keyCount: source.pairs.length,
        entries: seedEntries(db, locales, { force, now }),
        media: {
          counters: seedMedia(db, media.items, { force, now }),
          totalBytes: media.totalBytes,
          written,
        },
        projects: seedProjects(db, media.byFile, { force, now }),
        partners: seedPartners(db, media.byFile, { force, now }),
        advantages: seedAdvantages(db, media.byFile, { force }),
        stats: seedStats(db, { force, now }),
        phones: seedPhones(db, { force }),
        state: null,
      }
      result.state = updateAppState(db, now)

      // Сверка ВНУТРИ транзакции: она читает то, что только что записано,
      // и её провал обязан откатить запись, а не оставить полперевода.
      verify(db, locales)

      if (dryRun) throw new DryRunRollback()
    })
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error
  }

  printReport(result, { dryRun, force })
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof UsageError) {
    note(`Ошибка: ${error.message}\n`)
    note(usage())
    process.exitCode = 2
  } else {
    note(`Ошибка: ${error.message}`)
    if (error.cause) note(`  причина: ${error.cause.message ?? error.cause}`)
    process.exitCode = 1
  }
} finally {
  // Явное закрытие: при WAL незакрытое соединение оставляет -wal и -shm
  // и не выполняет контрольную точку.
  try {
    closeDb()
  } catch (error) {
    note(`Ошибка при закрытии базы: ${error.message}`)
  }
}
