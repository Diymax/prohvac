// Управление учётными записями админки из командной строки.
//
// ЗАЧЕМ ЭТО НУЖНО. Первого пользователя создавать некому: веб-форма регистрации
// в админке отсутствует намеренно (открытая регистрация в панели управления
// сайтом — это дыра, а не удобство), а на Plesk из инструментов есть только
// SSH. Отсюда же остальные команды: восстановить доступ, когда 2FA потеряна
// вместе с телефоном, снять блокировку после чужого перебора, забрать копию
// базы перед выкатом — всё это делается тогда, когда в админку не зайти.
//
// ПАРОЛЬ НИКОГДА НЕ ПЕРЕДАЁТСЯ АРГУМЕНТОМ. argv видно в `ps` любому
// пользователю машины (на shared-хостинге это не только мы), и он же целиком
// оседает в ~/.bash_history. Поэтому пароль читается с терминала без эха,
// а при запуске без терминала — генерируется и печатается ровно один раз.
//
// ЗАПУСК. Из корня проекта: относительный DATA_DIR (по умолчанию './data')
// резолвится от рабочего каталога, и запуск из другого места создал бы вторую,
// пустую базу вместо работы с боевой. Переменные окружения подкладываются
// флагом Node, чтобы не экспортировать их в сессию руками:
//
//   node --env-file=.env.local scripts/admin-cli.mjs list-users
//
// На Plesk переменные заданы в панели приложения; в SSH-сессии их обычно нет,
// и путь к базе стоит проверить по строке, которую скрипт печатает при старте.

import { randomInt } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import { generatePassword, validatePasswordStrength, PASSWORD_MIN } from '../server/auth/password.js'
import {
  createUser as createUserRecord,
  resetPassword as resetPasswordRecord,
  resetTwoFactor as resetTwoFactorRecord,
  UserAdminError,
} from '../server/application/user-admin.js'
import { config } from '../server/config.js'
import { hashIp } from '../server/crypto/hashid.js'
import { closeDb, getDb, DB_FILENAME } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrate.js'
import { createRateLimiter } from '../server/lib/ratelimit.js'
// Сама уборка живёт в server/lib/maintenance.js: её же по расписанию вызывает
// сервер (server/index.js). Вторая копия сроков хранения здесь неизбежно
// разошлась бы с первой — а это сроки хранения персональных данных.
import { compactDatabase, lastMaintenanceAt, runMaintenance } from '../server/lib/maintenance.js'

const ROLES = ['owner', 'admin', 'editor', 'viewer']

// Схема разрешает 3..32 символа любого содержания. Здесь ограничение строже:
// логин попадает в audit_log, в журнал попыток входа и в grep по логам, а
// пробелы, кавычки и управляющие символы в такой роли только мешают. Точка,
// дефис и подчёркивание оставлены — из них состоят реальные логины.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/i

// Сгенерированный пароль: 24 символа из алфавита в 56 знаков — это ~139 бит,
// то есть его стойкость не зависит от того, сменят ли его вовремя. Из алфавита
// выброшены O/0, I/l/1 и прочие пары, неразличимые в письме и в мессенджере:
// временный пароль передают человеку голосом или текстом, и «не тот символ»
// заканчивается ещё одной неудачной попыткой входа и блокировкой.
// Завершающий символ escape-последовательности терминала: у CSI ('ESC [ 1 ; 2 A')
// это буква, у клавиш редактирования ('ESC [ 3 ~') — тильда. Всё, что до него,
// относится к нажатой клавише, а не к паролю.
const ESCAPE_FINAL = /[A-Za-z~]/

/** Ошибка употребления команды: печатаем справку и выходим с кодом 2. */
class UsageError extends Error {}

const out = (line = '') => process.stdout.write(`${line}\n`)
// Служебные строки идут в stderr, чтобы stdout оставался чистым результатом:
// `admin-cli list-users > users.txt` не должен собирать в файл путь к базе.
const note = (line = '') => process.stderr.write(`${line}\n`)

const usage = () => `Управление учётными записями админки PROHVAC.

  node scripts/admin-cli.mjs <команда> [параметры]

Команды:
  create-user    --username <имя> [--role ${ROLES.join('|')}]
  reset-password --username <имя>
  reset-2fa      --username <имя>
  unlock         --username <имя> | --ip-hash <64 hex> | --ip <адрес>
  list-users
  backup         [--out <путь>]
  gc

Параметры:
  --password-stdin  взять пароль из стандартного ввода (для скриптов)
  --help            эта справка

Пароль не передаётся аргументом никогда: argv виден в ps и в истории shell.
С терминала он читается без эха и с подтверждением, без терминала —
генерируется и печатается один раз.

База: ${join(config.dataDir, DB_FILENAME)}
Запускать из корня проекта. Переменные окружения:
  node --env-file=.env.local scripts/admin-cli.mjs list-users
`

// ---------------------------------------------------------------------------
// Разбор аргументов
// ---------------------------------------------------------------------------

// Опции, у которых значения нет и быть не может. Список нужен, чтобы
// '--password-stdin create-user' не съел команду как значение флага: без него
// разбор молча остаётся без команды и ругается совсем не на то.
const FLAGS = new Set(['help', 'password-stdin'])

/**
 * Разбирает argv в позиционные аргументы и опции.
 *
 * Поддерживаются обе формы записи ('--role admin' и '--role=admin'), потому
 * что вторая обязательна для значений, начинающихся с дефиса, а первую пишут
 * руками все. Опция без значения (следом другая опция или конец строки)
 * становится флагом true.
 */
const parseArgs = (argv) => {
  const positional = []
  const options = new Map()

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }

    const eq = arg.indexOf('=')
    if (eq !== -1) {
      options.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }

    const name = arg.slice(2)
    const next = argv[i + 1]
    if (FLAGS.has(name) || next === undefined || next.startsWith('--')) {
      options.set(name, true)
      continue
    }
    options.set(name, next)
    i += 1
  }

  return { positional, options }
}

const optionString = (options, name) => {
  const value = options.get(name)
  if (value === undefined) return null
  if (value === true) throw new UsageError(`параметру --${name} нужно значение`)
  const text = String(value).trim()
  return text || null
}

const requireUsername = (options) => {
  const value = optionString(options, 'username')
  if (!value) throw new UsageError('нужен параметр --username <имя>')
  if (!USERNAME_PATTERN.test(value)) {
    throw new UsageError(
      `недопустимый логин "${value}": 3..32 символа, латиница, цифры, точка, дефис, подчёркивание`
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Пароль
// ---------------------------------------------------------------------------

/**
 * Читает строку с терминала, ничего не печатая в ответ на нажатия.
 *
 * Сырой режим, а не readline: readline с terminal=true отражает ввод в вывод,
 * и погасить эхо у него можно только приватным _writeToOutput. Здесь весь
 * разбор нажатий свой, зато он состоит из публичного API и делает ровно то,
 * что написано.
 */
const readHidden = (prompt) => new Promise((done, fail) => {
  const input = process.stdin
  let value = ''
  // Признак «идёт escape-последовательность». Живёт снаружи обработчика,
  // потому что стрелка может прийти разорванной между двумя порциями данных.
  let escaping = false

  const finish = (error, result) => {
    input.removeListener('data', onData)
    input.setRawMode(false)
    input.pause()
    // Перевод строки за пользователя: его Enter в сыром режиме не отразился,
    // и без этого следующая строка вывода приклеилась бы к приглашению.
    note()
    if (error) fail(error)
    else done(result)
  }

  const onData = (chunk) => {
    // Итерация по кодовым точкам, а не по единицам UTF-16: пароль может быть
    // на любом языке, и Backspace должен стирать символ целиком.
    for (const char of chunk) {
      // Стрелки, Home и End приходят как ESC '[' ... буква. Отбросить один
      // только ESC мало: остаток ('[A') состоит из печатных символов и молча
      // оказался бы внутри пароля, который пользователь потом не повторит.
      if (escaping) {
        if (ESCAPE_FINAL.test(char)) escaping = false
        continue
      }
      if (char === '\u001b') {
        escaping = true
        continue
      }

      // Enter — конец ввода. Ctrl+D тоже: в пустой строке это «ввода не будет».
      if (char === '\r' || char === '\n' || char === '\u0004') {
        finish(null, value)
        return
      }
      // Ctrl+C в сыром режиме до процесса как сигнал не доходит, обрабатываем сами.
      if (char === '\u0003') {
        finish(new Error('ввод отменён'))
        return
      }
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1)
        continue
      }
      // Остальные управляющие символы (стрелки приходят escape-последователь-
      // ностью) в пароль не годятся и молча отбрасываются.
      if (char < ' ') continue
      value += char
    }
  }

  // Приглашение в stderr: stdout может быть перенаправлен в файл, и тогда
  // человек смотрел бы на пустой экран, гадая, ждут ли от него ввода.
  process.stderr.write(prompt)
  input.setEncoding('utf8')
  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
})

const readAllStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  // Снимаем ровно один завершающий перевод строки: его дописывает echo и любой
  // heredoc. Остальные пробелы оставляем как есть — они могли быть в пароле.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

const assertStrength = (password, username) => {
  const strength = validatePasswordStrength(password, username)
  if (strength.ok) return password

  const reasons = {
    password_too_short: `пароль короче ${PASSWORD_MIN} символов`,
    password_too_long: 'пароль слишком длинный',
    password_equals_username: 'пароль совпадает с логином',
    invalid_payload: 'пароль не прочитан',
  }
  throw new Error(reasons[strength.error] ?? strength.error)
}

/**
 * Достаёт новый пароль одним из трёх способов и говорит, показывать ли его.
 *
 * @returns {Promise<{password: string, generated: boolean}>}
 */
const obtainPassword = async (username, options) => {
  if (options.get('password-stdin')) {
    // С терминала этот режим тоже работает, но эхо не гасится и конец ввода
    // надо обозначить самому — иначе выглядит как зависший скрипт.
    if (process.stdin.isTTY) note('Введите пароль и нажмите Ctrl+D (ввод виден на экране).')
    const password = await readAllStdin()
    return { password: assertStrength(password, username), generated: false }
  }

  // Нет терминала — значит, спрашивать некого: cron, деплой-скрипт, ssh с
  // командой в аргументе. Генерируем сами, иначе процесс молча повис бы
  // на чтении ввода, которого не будет.
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return { password: generatePassword(username), generated: true }
  }

  const password = await readHidden(`Пароль для ${username} (не отображается): `)
  const again = await readHidden('Повторите пароль: ')
  // Подтверждение обязательно: пароль не виден при наборе, а опечатка в нём
  // обнаружилась бы только при первой неудачной попытке входа.
  if (password !== again) throw new Error('пароли не совпадают')

  return { password: assertStrength(password, username), generated: false }
}

const printGenerated = (password) => {
  out('')
  out(`  пароль: ${password}`)
  out('')
  note('Пароль сгенерирован, показан один раз и в базе хранится только хешем.')
  note('Передайте его владельцу учётной записи и удалите из переписки.')
}

// ---------------------------------------------------------------------------
// Общее для команд, работающих с базой
// ---------------------------------------------------------------------------

/**
 * Открывает базу и доводит схему до актуальной.
 *
 * Миграции здесь не роскошь: create-user запускают на свежем хостинге, где
 * приложение ещё ни разу не стартовало и таблицы users не существует.
 */
const openDb = () => {
  const path = join(config.dataDir, DB_FILENAME)
  note(`[db] ${path}${existsSync(path) ? '' : ' (файла нет, будет создан)'}`)

  const db = getDb()
  const applied = runMigrations(db)
  if (applied.length) note(`[db] применены миграции: ${applied.join(', ')}`)
  return db
}

const findUser = (db, username) => {
  // Сравнение регистронезависимое за счёт COLLATE NOCASE на самой колонке:
  // 'Admin' и 'admin' — одна учётка, и CLI обязан вести себя так же, как вход.
  const user = db.get('SELECT * FROM users WHERE username = ?', [username])
  if (!user) throw new Error(`пользователь "${username}" не найден`)
  return user
}

const fmtTime = (ms) => {
  if (ms == null) return '—'
  // UTC без миллисекунд: время на хостинге и время у оператора почти наверняка
  // в разных поясах, и локальный формат в таблице только путал бы.
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

const fmtBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

/** Печать таблицы с выравниванием по самой длинной ячейке столбца. */
const printTable = (headers, rows) => {
  const widths = headers.map((header, column) =>
    rows.reduce((max, row) => Math.max(max, String(row[column]).length), header.length)
  )
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd()

  out(line(headers))
  out(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) out(line(row))
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

const createUser = async (db, options) => {
  const username = requireUsername(options)

  const requested = optionString(options, 'role')
  if (requested && !ROLES.includes(requested)) {
    throw new UsageError(`роль "${requested}" неизвестна, допустимы: ${ROLES.join(', ')}`)
  }

  const total = db.get('SELECT COUNT(*) AS n FROM users').n
  // Первый пользователь на пустой базе — это владелец: раздать права больше
  // некому. Все следующие по умолчанию получают минимальные права, потому что
  // «забыли указать роль» не должно означать «выдали полный доступ».
  const role = requested ?? (total === 0 ? 'owner' : 'viewer')

  const { password: given, generated } = await obtainPassword(username, options)
  // Правила — общие с админкой (server/application/user-admin.js): занятый
  // логин, форма логина, обязательная смена пароля и второй фактор.
  const { user } = await createUserRecord(db, { username, role, password: given })

  out(`создан пользователь #${user.id} ${user.username}, роль ${user.role}`)
  if (generated) printGenerated(given)
  note('При первом входе потребуется сменить пароль и подключить приложение-аутентификатор.')
}

const resetPassword = async (db, options) => {
  const username = requireUsername(options)
  const user = findUser(db, username)

  const { password: given, generated } = await obtainPassword(user.username, options)
  const { revoked } = await resetPasswordRecord(db, { userId: user.id, password: given })

  out(`пароль пользователя ${user.username} заменён, сессий отозвано: ${revoked}`)
  if (generated) printGenerated(given)
  note('Блокировка и счётчик неудачных попыток сброшены. При входе пароль нужно сменить.')
}

const resetTwoFactor = (db, options) => {
  const username = requireUsername(options)
  const user = findUser(db, username)
  const result = resetTwoFactorRecord(db, { userId: user.id })

  out(
    `2FA пользователя ${user.username} сброшена: секретов ${result.secrets}, ` +
    `кодов восстановления ${result.codes}, незавершённых подключений ${result.pending}, ` +
    `сессий отозвано ${result.revoked}`
  )
  note('При следующем входе будет предложено подключить приложение-аутентификатор заново.')
}

const IP_HASH_PATTERN = /^[0-9a-f]{64}$/i

const unlock = (db, options) => {
  const username = optionString(options, 'username')
  const rawHash = optionString(options, 'ip-hash')
  const ip = optionString(options, 'ip')

  const targets = [username, rawHash, ip].filter(Boolean).length
  if (targets !== 1) {
    throw new UsageError('укажите ровно одно: --username <имя>, --ip-hash <64 hex> или --ip <адрес>')
  }

  if (username) {
    const user = findUser(db, requireUsername(options))
    const { changes } = db.run(
      `UPDATE users
          SET failed_attempts = 0, locked_until = NULL, lock_level = 0, updated_at = ?
        WHERE id = ?`,
      [Date.now(), user.id]
    )
    out(`учётная запись ${user.username} разблокирована (изменено строк: ${changes})`)
    // Блокировка по адресу живёт отдельно: пользователь может войти с другой
    // сети, а перебиравшего с этого адреса разблокировать заодно мы не хотим.
    note('Блокировка по IP снимается отдельно: --ip-hash или --ip.')
    return
  }

  // Хеш адреса, а не адрес: сырых IP в базе нет нигде (см. server/crypto/hashid.js),
  // и в журнале блокировок оператор видит именно хеш. Форму --ip оставляем для
  // случая «адрес известен, хеш считать нечем» — он требует APP_SECRET.
  const ipHash = (rawHash ?? hashIp(ip)).toLowerCase()
  if (!IP_HASH_PATTERN.test(ipHash)) {
    throw new UsageError(`--ip-hash ожидает 64 шестнадцатеричных символа, получено "${rawHash}"`)
  }

  // Таблицу лимитера создаёт сам лимитер, а не миграция: до первого запроса
  // её может не быть, и DELETE упал бы на «no such table».
  createRateLimiter(db)

  const result = db.transaction(() => {
    const blocks = db.run('DELETE FROM ip_blocks WHERE ip_hash = ?', [ipHash]).changes
    // Снять блокировку мало: счётчики окон переживут её и заблокируют адрес
    // повторно на первой же попытке. Хеш — 64 hex, поэтому в LIKE он не может
    // оказаться шаблоном.
    const buckets = db.run(`DELETE FROM rate_limit WHERE bucket LIKE '%' || ?`, [ipHash]).changes
    // Таблицы rate_counters больше нет (миграция 002): она дублировала
    // rate_limit и никем не читалась. Обращение к ней внутри транзакции
    // роняло всю команду — снять ложную блокировку из CLI было невозможно,
    // а это единственный путь восстановления, когда админка недоступна.
    return { blocks, buckets, counters: 0 }
  })

  out(
    `адрес ${ipHash} разблокирован: блокировок ${result.blocks}, ` +
    `счётчиков лимитера ${result.buckets + result.counters}`
  )
  // Журнал попыток остаётся: он объясняет, за что адрес был заблокирован,
  // и на новые блокировки не влияет (их считают счётчики выше).
  note('Записи в login_attempts сохранены — это журнал, а не счётчик.')
}

const SQL_LIST_USERS = `
  SELECT u.id, u.username, u.role, u.status, u.must_change_password,
         u.totp_required, u.failed_attempts, u.locked_until, u.last_login_at,
         u.created_at,
         t.user_id IS NOT NULL AS has_totp,
         t.confirmed_at AS totp_confirmed_at,
         (SELECT COUNT(*) FROM recovery_codes r
           WHERE r.user_id = u.id AND r.used_at IS NULL) AS recovery_left
    FROM users u
    LEFT JOIN totp_secrets t ON t.user_id = u.id
   ORDER BY u.id
`

const twoFactorState = (user) => {
  if (!user.has_totp) return user.totp_required ? 'требуется' : 'нет'
  if (user.totp_confirmed_at == null) return 'не подтв.'
  return `да (${user.recovery_left} кодов)`
}

const listUsers = (db) => {
  const users = db.all(SQL_LIST_USERS)
  if (!users.length) {
    out('пользователей нет')
    note('Создайте владельца: node scripts/admin-cli.mjs create-user --username <имя>')
    return
  }

  const now = Date.now()
  printTable(
    ['id', 'логин', 'роль', 'статус', '2FA', 'пароль', 'неудач', 'блок до', 'вход', 'создан'],
    users.map((user) => [
      user.id,
      user.username,
      user.role,
      user.status,
      twoFactorState(user),
      user.must_change_password ? 'сменить' : 'ok',
      user.failed_attempts,
      // Истёкшую блокировку показываем как снятую: строка в базе живёт до
      // следующего входа, и без этой проверки оператор снимал бы блокировку,
      // которой уже нет.
      user.locked_until != null && user.locked_until > now ? fmtTime(user.locked_until) : '—',
      fmtTime(user.last_login_at),
      fmtTime(user.created_at),
    ])
  )
  note(`Всего: ${users.length}. Время в UTC.`)
}

const backupPath = (options) => {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
  const name = `${basename(DB_FILENAME, '.sqlite')}-${stamp}.sqlite.gz`

  const requested = optionString(options, 'out')
  // Путь резолвится от рабочего каталога, а умолчание — от DATA_DIR: бэкап
  // рядом с базой переживает выкат новой версии кода, а в каталоге проекта —
  // нет (Plesk разворачивает релиз в новый каталог).
  if (!requested) return join(config.dataDir, 'backups', name)

  const target = resolve(process.cwd(), requested)
  // Каталог в --out — это «положи туда с обычным именем»: так удобнее всего
  // писать в /var/backups, не выдумывая имя файла каждый раз.
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, name)
  return target
}

const backup = async (db, options) => {
  const target = backupPath(options)
  if (existsSync(target)) {
    throw new Error(`файл ${target} уже существует — перезаписывать бэкап скрипт не станет`)
  }

  mkdirSync(dirname(target), { recursive: true })

  // VACUUM INTO, а не копирование файла. При journal_mode=WAL свежие
  // транзакции лежат в app.sqlite-wal, и `cp app.sqlite` даёт базу без них
  // либо, если копировать в момент записи, порванную посередине. VACUUM INTO
  // выполняется в читающей транзакции и пишет согласованный снимок — включая
  // WAL и без свободных страниц, то есть заодно компактнее оригинала.
  const snapshot = `${target}.${process.pid}.tmp`
  try {
    db.run('VACUUM INTO ?', [snapshot])

    // Через поток, а не gzipSync над прочитанным буфером: база может быть
    // в сотню мегабайт, а памяти на shared-хостинге ровно столько, сколько
    // выделили процессу.
    await pipeline(createReadStream(snapshot), createGzip({ level: 9 }), createWriteStream(target))

    const raw = statSync(snapshot).size
    const packed = statSync(target).size
    out(target)
    note(`Снимок ${fmtBytes(raw)} сжат до ${fmtBytes(packed)}.`)
    note('Файл содержит заявки и хеши паролей — хранить как секрет.')
    // Секреты внутри (TOTP, токен бота) зашифрованы ключом из APP_SECRET,
    // и без него бэкап не восстанавливается. Про это забывают ровно тогда,
    // когда бэкап понадобился.
    note('Для восстановления понадобится тот же APP_SECRET — сохраните его отдельно.')
  } finally {
    // Снимок остаётся на диске и при ошибке сжатия, и при нехватке места;
    // на 500 МБ вторая копия базы — это половина свободного пространства.
    rmSync(snapshot, { force: true })
  }
}

/**
 * Уборка по требованию.
 *
 * Сервер делает то же самое сам, раз в сутки (server/index.js), поэтому команда
 * нужна ровно для двух случаев: прибрать прямо сейчас, не дожидаясь расписания,
 * и убедиться, что расписание вообще работает, — для второго печатается время
 * последнего автоматического прохода.
 *
 * Отметку last_purge_at команда не переставляет: ручной запуск не должен
 * сдвигать расписание сервера ни вперёд, ни назад.
 */
const gc = (db) => {
  const now = Date.now()
  const previous = lastMaintenanceAt(db)

  const result = runMaintenance(db, { now })

  printTable(
    ['что', 'удалено'],
    [
      ['сессии: помечены истёкшими', result.sessions.expired],
      ['сессии: удалены', result.sessions.deleted],
      ['заявки (истёк срок хранения ПДн)', result.leads],
      ['попытки входа', result.loginAttempts],
      ['блокировки IP', result.ipBlocks],
      ['счётчики лимитера', result.rateLimit],
      ['задачи перевода', result.translationJobs],
      ['записи аудита', result.auditLog],
    ]
  )

  note(previous
    ? `Автоматическая уборка последний раз проходила ${new Date(previous).toISOString()}.`
    : 'Автоматическая уборка ещё ни разу не проходила (сервер не запускался с этой базой).')

  // Мягко удалённые media не трогаем: у них есть файл на диске, и удалять
  // строку раньше файла означает потерять единственную ссылку на этот файл.
  // Этим занимается уборщик медиа, который умеет ходить в файловую систему.
  note('Файлы медиа не затронуты — их убирает отдельная чистка.')

  if (!compactDatabase(db)) note('WAL не удалось свернуть: база занята другим процессом.')
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

const COMMANDS = new Map([
  ['create-user', { needsDb: true, run: createUser }],
  ['reset-password', { needsDb: true, run: resetPassword }],
  ['reset-2fa', { needsDb: true, run: resetTwoFactor }],
  ['unlock', { needsDb: true, run: unlock }],
  ['list-users', { needsDb: true, run: listUsers }],
  ['backup', { needsDb: true, run: backup }],
  ['gc', { needsDb: true, run: gc }],
])

const main = async () => {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const name = positional[0]

  // Явная просьба о справке — успех, а запуск без команды — ошибка
  // употребления: она чаще всего означает опечатку в строке запуска,
  // и нулевой код скрыл бы её от вызывающего скрипта.
  if (options.get('help')) {
    note(usage())
    return 0
  }
  if (!name) {
    note(usage())
    return 2
  }

  const command = COMMANDS.get(name)
  if (!command) throw new UsageError(`неизвестная команда "${name}"`)
  if (positional.length > 1) {
    throw new UsageError(`лишние аргументы: ${positional.slice(1).join(' ')}`)
  }

  const db = command.needsDb ? openDb() : null
  await command.run(db, options)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof UsageError) {
    note(`Ошибка: ${error.message}\n`)
    note(usage())
    process.exitCode = 2
  } else if (error instanceof UserAdminError) {
    // Отказ по правилу, а не сбой: занятый логин, последний владелец, слабый
    // пароль. Стек и «причина нижнего уровня» здесь не помогут — помогает
    // другой ввод, поэтому печатаем только причину и её код.
    note(`Отказано: ${error.message} (${error.code})`)
    process.exitCode = 2
  } else {
    note(`Ошибка: ${error.message}`)
    // Причина нижнего уровня (SQLITE_*, EACCES) в сообщении не видна, а именно
    // она обычно и объясняет, что чинить.
    if (error.cause) note(`  причина: ${error.cause.message ?? error.cause}`)
    process.exitCode = 1
  }
} finally {
  // Закрываем базу явно: при WAL незакрытое соединение оставляет -wal и -shm,
  // а контрольная точка не выполняется — файл журнала растёт от запуска
  // к запуску, и на 500 МБ диска это заметно.
  try {
    closeDb()
  } catch (error) {
    note(`Ошибка при закрытии базы: ${error.message}`)
  }
  // Сырой режим снят в readHidden, но stdin мог остаться в resume() после
  // чтения через поток: неостановленный stdin держит цикл событий, и процесс
  // не завершился бы, отработав всю команду.
  process.stdin.pause()
}
