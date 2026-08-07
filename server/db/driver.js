// Адаптер над node:sqlite.
//
// ЗАЧЕМ ПРОСЛОЙКА. Это единственный файл сервера, который знает, каким
// драйвером открыта база. Всё остальное работает с объектом
// { exec, prepare, get, all, run, transaction, close }, поэтому смена
// хранилища (другая сборка sqlite, клиент к внешней БД) стоит одного нового
// файла рядом, а не правки в каждом запросе. Проверять это удобно и в тестах:
// вместо файла на диске подсовывается объект с теми же семью методами.
//
// ДОСТУПНОСТЬ МОДУЛЯ. node:sqlite появился в Node 22.5 под флагом
// --experimental-sqlite и открылся без флага только с 22.13. В панели Plesk
// версия выбирается из списка, и «Node 22» там запросто окажется 22.11 —
// поэтому загрузка обёрнута в try/catch с внятной подсказкой.
//
// Модуль берётся через process.getBuiltinModule, а не статическим import:
// статический import отсутствующего builtin рвёт загрузку ВСЕГО графа модулей
// ещё до первой строки нашего кода, и перехватить это нечем — в лог падает
// голый ERR_UNKNOWN_BUILTIN_MODULE без единого намёка на флаг.

const NODE_HINT =
  'Нужен Node 22.13 или новее (в Plesk: Node.js → Node.js version), ' +
  'либо добавьте в переменные окружения приложения NODE_OPTIONS=--experimental-sqlite.'

// Модуль резолвится один раз на процесс: getBuiltinModule дешёвый, но ошибку
// про версию Node незачем собирать заново на каждое открытие соединения.
let sqlite = null

/**
 * Возвращает модуль node:sqlite либо бросает ошибку с подсказкой.
 * Вынесено в экспорт, чтобы проверку доступности можно было сделать при старте
 * (app.cjs) и не узнавать о неподходящем Node на первом запросе пользователя.
 */
export const loadSqlite = () => {
  if (sqlite) return sqlite

  let found = null
  let cause = null
  try {
    // Опциональный вызов: getBuiltinModule есть с Node 22.3, на более старых
    // сборках его просто нет — и это тот же самый диагноз «Node слишком старый»,
    // а не TypeError про undefined.
    found = process.getBuiltinModule?.('node:sqlite') ?? null
  } catch (error) {
    // Под флагом-гейтом обращение к модулю бросает, а не возвращает undefined —
    // поведение разное в разных минорных версиях, поэтому ловим оба варианта.
    cause = error
  }

  if (!found?.DatabaseSync) {
    throw new Error(
      `Модуль node:sqlite недоступен в этой сборке Node (${process.version}). ${NODE_HINT}`,
      cause ? { cause } : undefined
    )
  }

  sqlite = found
  return sqlite
}

/**
 * Приводит аргументы к списку параметров SQL.
 *
 * Поддерживаются три формы вызова, потому что вызывающий код делится на два
 * лагеря: горячие пути готовят statement заранее и передают параметры
 * позиционно (stmt.get(a, b)), а разовые запросы удобнее писать
 * с массивом (db.get(sql, [a, b])). Именованные параметры — объектом.
 *
 * undefined в единственном аргументе означает «параметров нет»: так
 * db.all(sql) без второго аргумента не превращается в all(undefined),
 * который node:sqlite отвергает как значение неподдерживаемого типа.
 */
const normalizeParams = (args) => {
  if (args.length === 1) {
    const [first] = args
    if (first === undefined) return []
    if (Array.isArray(first)) return first
  }
  return args
}

// Обёртка над StatementSync. Наружу торчат только три метода: iterate и
// setReadBigInts специфичны для node:sqlite, и код, который ими воспользуется,
// перестанет переезжать на другой драйвер — ровно то, ради чего этот файл.
const wrapStatement = (statement) => ({
  get: (...args) => statement.get(...normalizeParams(args)),
  all: (...args) => statement.all(...normalizeParams(args)),
  run: (...args) => statement.run(...normalizeParams(args)),
})

/**
 * Открывает файл базы и возвращает драйвер.
 *
 * Прагмы здесь НЕ выставляются: они зависят от режима работы приложения
 * и живут в server/db/index.js — иначе настройки соединения оказались бы
 * размазаны по двум файлам и разъехались.
 *
 * @param {string} filename путь к файлу базы (':memory:' для тестов)
 */
export const createSqliteDriver = (filename) => {
  const { DatabaseSync } = loadSqlite()

  const db = new DatabaseSync(filename, {
    // Ссылочная целостность включена и дублируется прагмой в index.js:
    // опция действует на открытии, прагма — на переоткрытии соединения пулом.
    enableForeignKeyConstraints: true,
    // Двойные кавычки — строго идентификаторы. С включённой совместимостью
    // SQLite молча превращает опечатку в имени колонки ("nmae") в строковый
    // литерал, и запрос возвращает не ошибку, а неверные данные.
    enableDoubleQuotedStringLiterals: false,
  })

  let closed = false
  // Глубина вложенности транзакций: 0 — транзакции нет.
  let depth = 0

  const exec = (sql) => db.exec(sql)

  // Без кэша: каждый вызов заново разбирает SQL. Кэш подготовленных выражений
  // живёт этажом выше (server/db/index.js) — драйвер обязан оставаться
  // предсказуемым, а решение «переиспользовать statement» принимает тот,
  // кто знает время жизни соединения.
  const prepare = (sql) => wrapStatement(db.prepare(sql))

  const get = (sql, params) => prepare(sql).get(params)
  const all = (sql, params) => prepare(sql).all(params)
  const run = (sql, params) => prepare(sql).run(params)

  /**
   * Выполняет fn внутри транзакции. Возвращает то, что вернул fn.
   * При исключении откатывает и пробрасывает ошибку дальше.
   *
   * BEGIN IMMEDIATE, а не обычный BEGIN. Обычный (deferred) начинается
   * как читающий и берёт блокировку записи только на первом UPDATE. Если
   * к этому моменту запись захватил соседний процесс пула, апгрейд возвращает
   * SQLITE_BUSY НЕМЕДЛЕННО, в обход busy_timeout: обе стороны уже держат
   * снимок данных, и ожидание ничего не решит. IMMEDIATE берёт блокировку
   * сразу — там busy_timeout работает как задумано, и вместо случайных
   * SQLITE_BUSY процессы просто выстраиваются в очередь.
   */
  const transaction = (fn) => {
    if (typeof fn !== 'function') {
      throw new TypeError(`transaction() ожидает функцию, получено ${typeof fn}`)
    }

    // Вложенный вызов не может открыть вторую транзакцию (SQLite их не имеет),
    // но точка отката ему нужна своя: иначе ошибка во внутреннем блоке
    // откатила бы всю внешнюю работу.
    const nested = depth > 0
    const savepoint = `sp_${depth}`

    exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
    depth += 1

    try {
      const result = fn()

      // Асинхронный колбэк — тихая потеря атомарности: fn вернул бы промис,
      // COMMIT прошёл бы прямо сейчас, а сами запросы выполнились позже,
      // уже вне транзакции. node:sqlite синхронный, async тут не нужен.
      if (typeof result?.then === 'function') {
        throw new TypeError(
          'transaction(): колбэк не может быть async и не может возвращать Promise — ' +
          'node:sqlite синхронный, COMMIT произошёл бы раньше самих запросов'
        )
      }

      exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
      return result
    } catch (error) {
      try {
        // ROLLBACK TO возвращает состояние к точке, RELEASE снимает саму точку:
        // без второй команды savepoint остался бы висеть до конца внешней
        // транзакции и следующий вход на ту же глубину переиспользовал бы имя.
        exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
      } catch {
        // Откат сам может упасть — например, SQLite уже откатил транзакцию
        // при неудачном COMMIT, и активной транзакции больше нет. Настоящая
        // причина сбоя в error, и подменять её ошибкой отката нельзя.
      }
      throw error
    } finally {
      depth -= 1
    }
  }

  /**
   * Закрывает соединение. Повторный вызов безопасен: закрытие дёргается
   * и из обработчика сигнала, и из закрывающего кода тестов.
   */
  const close = () => {
    if (closed) return
    closed = true

    // Незакрытая транзакция не даёт закрыть базу. Такое бывает при аварийном
    // завершении посреди работы: откатываем, чтобы close() не бросил поверх
    // уже происходящей ошибки.
    if (depth > 0) {
      try {
        exec('ROLLBACK')
      } catch {
        // Транзакции может и не быть — глушим, закрыть базу важнее.
      }
      depth = 0
    }

    db.close()
  }

  return {
    filename,
    exec,
    prepare,
    get,
    all,
    run,
    transaction,
    close,
    get isOpen() {
      return !closed
    },
    // Признак «идёт транзакция» нужен коду, который решает, открывать свою
    // или присоединиться к чужой (например, миграции внутри общего блока).
    get inTransaction() {
      return depth > 0
    },
  }
}
