// Единственная точка открытия базы. Все модули берут соединение отсюда
// вызовом getDb() и никогда не создают своё: файл один, а лишнее соединение —
// это ещё один читатель, держащий снимок WAL, и ещё один набор прагм,
// которые кто-нибудь забудет выставить.
//
// Соединение НЕ общее на весь хостинг, а своё у каждого процесса пула
// Passenger. Общее у них — файл на диске, и именно поэтому здесь важны
// journal_mode=WAL и busy_timeout: без них параллельная запись из четырёх
// процессов возвращает SQLITE_BUSY вместо того, чтобы подождать своей очереди.
//
// Миграции отсюда не запускаются намеренно: их гоняет старт приложения
// (app.cjs) и отдельный скрипт, один раз, а не каждый процесс на первом
// обращении к базе — см. server/db/migrate.js.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { config } from '../config.js'
import { createSqliteDriver } from './driver.js'

export const DB_FILENAME = 'app.sqlite'

// Потолок кэша подготовленных выражений. Ограничение обязательно: часть SQL
// собирается из фильтров админки (сортировки, наборы условий), число вариантов
// строки не ограничено ничем, и безразмерный кэш превратился бы в утечку —
// в каждом процессе пула, по statement на каждую когда-либо встреченную форму
// запроса. 128 с запасом покрывает все постоянные запросы приложения.
const STATEMENT_CACHE_MAX = 128

const applyPragmas = (driver) => {
  // busy_timeout ПЕРВЫМ. Переключение журнала берёт эксклюзивную блокировку,
  // и если соседний процесс в этот момент читает, PRAGMA journal_mode упадёт
  // с SQLITE_BUSY. С уже выставленным таймаутом она подождёт.
  driver.exec('PRAGMA busy_timeout = 5000')

  // WAL: читатели не блокируют писателя, а писатель — читателей. Для пула
  // процессов это единственный рабочий режим; в journal_mode=delete любой
  // отчёт в админке останавливал бы приём заявок на время своего выполнения.
  // Режим записан в самом файле базы и переживает перезапуск, но выставляем
  // его при каждом открытии: база могла быть создана заново или скопирована.
  const journalMode = driver.get('PRAGMA journal_mode = WAL')?.journal_mode
  if (journalMode !== 'wal') {
    // Не падаем: сайт без WAL работает, просто хуже под нагрузкой. Обычная
    // причина — база на сетевом разделе, где блокировки WAL недоступны.
    console.warn(`[db] journal_mode=${journalMode} вместо wal — ` +
      'параллельные чтение и запись будут блокировать друг друга. ' +
      'Проверьте, что DATA_DIR на локальном диске, а не на сетевом разделе.')
  }

  // Прагма на соединение, а не на файл: её нужно повторять при каждом
  // открытии, иначе ON DELETE CASCADE и REFERENCES из схемы не действуют
  // и в базе остаются сессии удалённых пользователей.
  driver.exec('PRAGMA foreign_keys = ON')

  // NORMAL осмыслен только вместе с WAL: fsync делается на контрольной точке,
  // а не на каждом COMMIT. Ценой аварии по питанию могут стать последние
  // транзакции, но база остаётся целой — для заявок и правок контента это
  // приемлемо, а FULL на дисках shared-хостинга стоит дороже всего остального.
  driver.exec('PRAGMA synchronous = NORMAL')
}

/**
 * Оборачивает драйвер кэшем подготовленных выражений.
 *
 * prepare() — это разбор SQL и построение плана. На горячих путях (лимитер
 * запросов, проверка сессии, отдача контента) один и тот же запрос выполняется
 * на каждом HTTP-обращении, и повторный разбор — чистые накладные расходы.
 *
 * Вытеснение по давности использования: Map хранит порядок вставки, поэтому
 * «переложить в конец» — это delete + set, а самый давний ключ всегда первый.
 */
const withStatementCache = (driver) => {
  const cache = new Map()

  const prepare = (sql) => {
    const cached = cache.get(sql)
    if (cached) {
      cache.delete(sql)
      cache.set(sql, cached)
      return cached
    }

    const statement = driver.prepare(sql)
    cache.set(sql, statement)
    if (cache.size > STATEMENT_CACHE_MAX) {
      cache.delete(cache.keys().next().value)
    }
    return statement
  }

  return {
    filename: driver.filename,
    exec: (sql) => driver.exec(sql),
    prepare,
    get: (sql, params) => prepare(sql).get(params),
    all: (sql, params) => prepare(sql).all(params),
    run: (sql, params) => prepare(sql).run(params),
    transaction: (fn) => driver.transaction(fn),
    close: () => {
      // Кэш чистим до закрытия: statement'ы закрытой базы бесполезны, а живые
      // ссылки на них удерживают внутренние объекты драйвера в памяти.
      cache.clear()
      driver.close()
    },
    get isOpen() {
      return driver.isOpen
    },
    get inTransaction() {
      return driver.inTransaction
    },
  }
}

const openDatabase = () => {
  // recursive: true заодно делает вызов идемпотентным — каталог уже создан
  // соседним процессом пула в 99% случаев, и это не ошибка.
  try {
    mkdirSync(config.dataDir, { recursive: true })
  } catch (error) {
    throw new Error(
      `Не удалось создать каталог данных ${config.dataDir}: ${error.message}. ` +
      'Проверьте права пользователя приложения и переменную DATA_DIR.',
      { cause: error }
    )
  }

  const driver = createSqliteDriver(join(config.dataDir, DB_FILENAME))
  applyPragmas(driver)
  return withStatementCache(driver)
}

let db = null

/**
 * Открытое соединение. Ленивое: модуль импортируется тестами и утилитами,
 * которым база не нужна, и создавать ради них файл на диске незачем.
 * Под Passenger соединение появится на первом запросе к процессу.
 */
export const getDb = () => {
  if (!db) db = openDatabase()
  return db
}

/**
 * Закрывает соединение. Нужен при завершении процесса и между тестами,
 * чтобы следующий getDb() открыл базу заново.
 */
export const closeDb = () => {
  if (!db) return

  const current = db
  // Ссылку сбрасываем ДО close(): если закрытие бросит, повторный getDb()
  // должен открыть новое соединение, а не вернуть заведомо мёртвое.
  db = null
  current.close()
}
