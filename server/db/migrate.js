// Раннер миграций: применяет server/db/migrations/*.sql по порядку имён
// и запоминает применённое в schema_migrations.
//
// ПОЧЕМУ ФАЙЛЫ, А НЕ CREATE TABLE IF NOT EXISTS В КОДЕ. Схема нужна и на
// боевом хостинге, и в тестах, и в дампе для разбора инцидента. Файл — это
// то, что можно прочитать глазами и сравнить с базой; «IF NOT EXISTS» внутри
// модулей молча расходится с реальностью, как только у таблицы появляется
// вторая версия: существующую таблицу такой запрос не трогает, и колонка,
// добавленная в код, на боевой базе не появляется никогда.
//
// ИДЕМПОТЕНТНОСТЬ. Раннер безопасно запускать при каждом старте: применяются
// только файлы, которых нет в журнале. Уже применённая миграция не выполняется
// повторно, даже если её содержимое изменили — поэтому править файл после
// выката нельзя, нужен следующий по номеру.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// import.meta.dirname вместо fileURLToPath(import.meta.url): миграции лежат
// рядом с этим файлом, а рабочий каталог процесса под Passenger и под cron
// разный, и относительный путь нашёл бы каталог только в одном из случаев.
export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations')

// Числовой префикс фиксированной ширины обязателен: сортировка строковая,
// и без нулей '10_media.sql' встал бы перед '9_users.sql', то есть порядок
// применения разошёлся бы с порядком, который автор имел в виду.
const NAME_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/

// Журнал заводится здесь, а не миграцией: чтобы узнать, какие миграции уже
// применены, таблица нужна до применения первой из них. Определение дословно
// повторяет 001_init.sql — IF NOT EXISTS оставит ту, что окажется первой.
const JOURNAL_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ) STRICT, WITHOUT ROWID
`

const listMigrationFiles = (dir) => {
  let entries
  try {
    entries = readdirSync(dir)
  } catch (error) {
    throw new Error(
      `Каталог миграций недоступен: ${dir} (${error.code ?? error.message}). ` +
      'Проверьте, что файлы схемы выгружены на хостинг вместе с кодом.',
      { cause: error }
    )
  }

  const files = entries.filter((name) => name.endsWith('.sql'))
  for (const name of files) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Недопустимое имя миграции "${name}". Ожидается формат 001_init.sql: ` +
        'три и более цифры, подчёркивание, строчные латинские буквы, цифры и подчёркивания.'
      )
    }
  }

  return files.sort()
}

const readMigration = (dir, name) => {
  const sql = readFileSync(join(dir, name), 'utf8')
  // BOM оставляют редакторы под Windows. Для SQLite это мусор перед первым
  // выражением, и вся миграция падает на syntax error возле невидимого символа.
  return sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql
}

/**
 * Применяет недостающие миграции.
 *
 * Каждый файл выполняется в собственной транзакции вместе с записью в журнал:
 * либо схема изменилась и это записано, либо не изменилось ничего. Частично
 * применённая миграция — худший из возможных исходов, потому что следующий
 * запуск считает её невыполненной и начнёт заново поверх половины изменений.
 *
 * Транзакция драйвера открывается через BEGIN IMMEDIATE, поэтому одновременный
 * старт нескольких процессов пула безопасен: второй ждёт на busy_timeout,
 * а дождавшись — видит запись в журнале и пропускает файл. Повторная проверка
 * ВНУТРИ транзакции для этого и нужна: список применённого читался до неё,
 * когда чужая миграция ещё не была зафиксирована.
 *
 * @param {object} db соединение из server/db/index.js
 * @param {{dir?: string}} [options] каталог миграций (подменяется в тестах)
 * @returns {string[]} имена применённых в этом вызове миграций
 */
export const runMigrations = (db, { dir = MIGRATIONS_DIR } = {}) => {
  db.exec(JOURNAL_SQL)

  const files = listMigrationFiles(dir)
  const applied = new Set(db.all('SELECT name FROM schema_migrations').map((row) => row.name))
  const done = []

  for (const name of files) {
    if (applied.has(name)) continue

    const sql = readMigration(dir, name)
    const changed = db.transaction(() => {
      if (db.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', [name])) return false

      // Пустой файл (или файл из одних комментариев) — не ошибка: миграция
      // может отменять саму себя, оставаясь в журнале ради номера.
      if (sql.trim()) db.exec(sql)
      db.run('INSERT INTO schema_migrations (name) VALUES (?)', [name])
      return true
    })

    if (changed) done.push(name)
  }

  return done
}

/**
 * Список миграций, которые ещё не применены. Нужен проверке готовности
 * (health) и деплою: сервер, поднятый на базе со старой схемой, отдаёт 500
 * на половине маршрутов, и знать об этом лучше до переключения трафика.
 *
 * @returns {string[]}
 */
export const pendingMigrations = (db, { dir = MIGRATIONS_DIR } = {}) => {
  db.exec(JOURNAL_SQL)

  const applied = new Set(db.all('SELECT name FROM schema_migrations').map((row) => row.name))
  return listMigrationFiles(dir).filter((name) => !applied.has(name))
}
