// Счётчик запросов поверх SQLite.
//
// ПОЧЕМУ БД, А НЕ Map В ПАМЯТИ.
// На Plesk приложение обслуживает Passenger, а он держит ПУЛ процессов Node
// и раскидывает запросы между ними произвольно. Map живёт внутри одного
// процесса, поэтому каждый воркер считал бы свой счётчик: при пуле из четырёх
// процессов «5 запросов в минуту» фактически превращаются в 20, а точное число
// зависит от того, как балансировщик разложит запросы, — то есть лимит
// становится недетерминированным. Вдобавок Passenger штатно усыпляет и
// перезапускает простаивающие воркеры, и вместе с процессом исчезает окно.
// Общий файл SQLite — единственное состояние, которое видят все процессы сразу
// и которое переживает перезапуск.
//
// Модуль намеренно не открывает БД сам и не импортирует node:sqlite:
// соединение приходит снаружи (server/lib/db.js), где выставлены journal_mode
// WAL и busy_timeout. Без них параллельная запись из нескольких процессов
// падает с SQLITE_BUSY вместо того, чтобы подождать.

// WITHOUT ROWID: строки крошечные и всегда адресуются по полному первичному
// ключу. Обычная таблица держала бы два b-дерева (rowid + уникальный индекс)
// вместо одного — лишние страницы на диске, которого выделено 500 МБ.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rate_limit (
    bucket       TEXT    NOT NULL,
    window_start INTEGER NOT NULL,
    window_ms    INTEGER NOT NULL,
    count        INTEGER NOT NULL,
    PRIMARY KEY (bucket, window_start)
  ) WITHOUT ROWID
`

// Слоты дискретны: окно привязано к сетке времени, а не к первому запросу.
// Так все процессы вычисляют одну и ту же границу окна из одного лишь
// Date.now(), без общего «времени старта», которое пришлось бы читать из БД.
const slotStart = (now, windowMs) => Math.floor(now / windowMs) * windowMs

const assertWindowMs = (windowMs) => {
  // Дробный или нулевой windowMs даёт нецелый window_start (а при нуле —
  // NaN), и он молча ложится в ключ таблицы: слоты перестают совпадать между
  // вызовами, лимит фактически отключается. Лучше упасть сразу.
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new TypeError(`ratelimit: windowMs должен быть целым > 0, получено ${windowMs}`)
  }
}

const assertMax = (max) => {
  if (typeof max !== 'number' || Number.isNaN(max) || max <= 0) {
    throw new TypeError(`ratelimit: max должен быть числом > 0, получено ${max}`)
  }
}

/**
 * @param {object} db открытое соединение node:sqlite (DatabaseSync)
 */
export const createRateLimiter = (db) => {
  db.exec(SCHEMA)

  // Готовим statement'ы один раз: hit вызывается на каждом запросе,
  // а повторный prepare — это повторный разбор SQL.
  //
  // Инкремент и чтение результата — один statement с RETURNING. Вариант
  // «SELECT, потом UPDATE» между двумя процессами теряет инкременты: оба
  // прочитали бы одно и то же значение и записали count+1 вместо count+2.
  const incrementSlot = db.prepare(`
    INSERT INTO rate_limit (bucket, window_start, window_ms, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
    RETURNING count
  `)
  const readSlot = db.prepare(
    'SELECT count FROM rate_limit WHERE bucket = ? AND window_start = ?'
  )
  const deleteBucket = db.prepare('DELETE FROM rate_limit WHERE bucket = ?')
  // Порог считаем по window_ms самой строки: разные ведра живут с разными
  // окнами (логин — минуты, заявки — часы), общей константы тут быть не может.
  const deleteStale = db.prepare(
    'DELETE FROM rate_limit WHERE window_start + window_ms * 2 <= ?'
  )

  const describe = (count, max, resetAt) => ({
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetAt,
    count,
  })

  /**
   * Учитывает попытку и говорит, укладывается ли она в лимит.
   * Счётчик растёт и после превышения — по нему считается прогрессивная
   * задержка, и заодно видно масштаб перебора.
   *
   * `now` подменяется в тестах, чтобы проверять переход через границу окна
   * без ожидания реального времени.
   *
   * @returns {{allowed: boolean, remaining: number, resetAt: number, count: number}}
   */
  const hit = (bucket, { windowMs, max, now = Date.now() } = {}) => {
    assertWindowMs(windowMs)
    assertMax(max)

    const windowStart = slotStart(now, windowMs)
    const row = incrementSlot.get(String(bucket), windowStart, windowMs)
    return describe(row.count, max, windowStart + windowMs)
  }

  /** То же самое, но без инкремента: для ответов вида «сколько осталось». */
  const peek = (bucket, { windowMs, max = Infinity, now = Date.now() } = {}) => {
    assertWindowMs(windowMs)
    assertMax(max)

    const windowStart = slotStart(now, windowMs)
    const row = readSlot.get(String(bucket), windowStart)
    // Без max трактуем лимит как бесконечный: remaining === Infinity —
    // явный признак «предел не задан», в отличие от нуля или null.
    return describe(row ? row.count : 0, max, windowStart + windowMs)
  }

  /** Снимает лимит с ведра целиком: успешный вход, разбан из админки. */
  const reset = (bucket) => deleteBucket.run(String(bucket)).changes

  /**
   * Убирает отработавшие слоты. Держим два окна, а не одно: текущее окно
   * трогать нельзя, а предыдущее нужно на границе — часы процессов расходятся
   * на десятки миллисекунд, и слишком жадная уборка подарила бы клиенту
   * чистый счётчик ровно в момент смены слота.
   *
   * @returns {number} сколько строк удалено
   */
  const gc = (now = Date.now()) => deleteStale.run(now).changes

  return { hit, peek, reset, gc }
}

// Первые две неудачи бесплатны: опечатка в пароле — норма, наказывать за неё
// задержкой значит мучить живого человека ради нулевого выигрыша.
export const PROGRESSIVE_FREE_ATTEMPTS = 2
export const PROGRESSIVE_BASE_MS = 250
// Потолок задержки. Выше — Passenger и обратный прокси начнут рвать соединение
// по таймауту, и вместо «медленно» пользователь получит ошибку сети.
export const PROGRESSIVE_MAX_MS = 5_000

/**
 * Пауза перед ответом после n-й неудачной попытки.
 * 0, 0, 250, 500, 1000, 2000, 4000, 5000, 5000, ...
 *
 * Тормозит перебор пароля там, где лимит по количеству ещё не сработал:
 * подбор становится дороже на порядки, а обычный вход не замечает разницы.
 */
export const progressiveDelayMs = (failCount) => {
  const n = Math.floor(Number(failCount))
  // NaN и отрицательные — мусор, задержки нет. Infinity сознательно НЕ
  // отбрасываем: он пройдёт дальше и упрётся в потолок. Ошибка в подсчёте
  // попыток должна замедлять перебор, а не выключать защиту.
  if (Number.isNaN(n) || n <= PROGRESSIVE_FREE_ATTEMPTS) return 0

  const steps = n - PROGRESSIVE_FREE_ATTEMPTS - 1
  return Math.min(PROGRESSIVE_BASE_MS * 2 ** steps, PROGRESSIVE_MAX_MS)
}
