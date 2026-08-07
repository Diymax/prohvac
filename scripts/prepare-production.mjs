// Подготовка боевого окружения: генерация секретов и проверка конфигурации.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Требования к боевым значениям разбросаны по трём
// местам: docs/DEPLOYMENT.md (что задать), .env.example (комментарии) и
// server/config.js (что именно считается негодным). Оператор, ставящий сайт
// в первый раз, сводит их вручную и узнаёт об ошибке уже от Passenger —
// приложение не поднялось, в панели одна строка. Здесь секреты выдаются
// готовыми, а конфигурация проверяется ДО выката, тем же кодом, который
// потом решает, стартовать процессу или нет.
//
// Секреты печатаются в stdout и никуда не сохраняются: файл с боевыми
// ключами внутри релиза — это ровно то, чего требует не делать
// docs/DEPLOYMENT.md. Вставлять их нужно в панель хостинга.
//
// Режимы:
//   node scripts/prepare-production.mjs            — сгенерировать и показать
//   node scripts/prepare-production.mjs --check    — проверить текущее окружение
//
// Проверка запускается в дочернем процессе: server/config.js валидирует всё
// при импорте и бросает исключение, а поймать его надо, а не упасть вместе
// с ним.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const SECRET_BYTES = 32
const ADMIN_PATH_BYTES = 16

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')

const line = (text = '') => console.log(text)

// --- Node ------------------------------------------------------------------

const requiredEngine = JSON.parse(readFileSync('package.json', 'utf8')).engines?.node || ''
const [major, minor] = process.versions.node.split('.').map(Number)
// Диапазон из package.json: >=22.13 <25. Проверяем по нижней и верхней
// границе явно — семвер-парсер ради одной строки тянуть незачем.
const nodeOk = (major === 22 && minor >= 13) || (major > 22 && major < 25)

line(`Node ${process.versions.node} (требуется ${requiredEngine}) — ${nodeOk ? 'подходит' : 'НЕ ПОДХОДИТ'}`)
if (!nodeOk) {
  line('Сервер использует встроенный node:sqlite; на другой версии он не запустится.')
}

// node:sqlite может быть собран не во всех сборках Node — проверяем наличие,
// а не только номер версии.
let sqliteOk = true
try {
  await import('node:sqlite')
} catch (error) {
  sqliteOk = false
  line(`node:sqlite недоступен: ${error.message}`)
}
line(`node:sqlite — ${sqliteOk ? 'доступен' : 'НЕДОСТУПЕН'}`)

// --- Сборка ----------------------------------------------------------------

const distReady = existsSync('dist/index.html')
line(`dist/index.html — ${distReady ? 'есть' : 'НЕТ (соберите: npm run build)'}`)

if (!checkOnly) {
  // --- Генерация -----------------------------------------------------------

  const appSecret = randomBytes(SECRET_BYTES).toString('hex')
  const gateSecret = randomBytes(SECRET_BYTES).toString('hex')
  const adminPath = randomBytes(ADMIN_PATH_BYTES).toString('hex')

  line('')
  line('Значения для панели хостинга (переменные окружения приложения).')
  line('НЕ коммитить, не класть в файл внутри релиза, APP_SECRET не терять:')
  line('его потеря делает нечитаемыми все зашифрованные настройки и рвёт сессии.')
  line('')
  line('NODE_ENV=production')
  line(`APP_SECRET=${appSecret}`)
  line(`GATE_SECRET=${gateSecret}`)
  line(`ADMIN_SECRET_PATH=${adminPath}`)
  line('PUBLIC_ORIGIN=https://www.prohvac.uz')
  line('DATA_DIR=/абсолютный/путь/вне/document root')
  line('TELEGRAM_BOT_TOKEN=<токен от @BotFather>')
  line('TELEGRAM_CHAT_ID=<id чата или @канал>')
  line('ANALYTICS_ENABLED=1')
  // За обратным прокси адрес посетителя приходит в заголовке. Без этой
  // переменной он у всех одинаковый: лимиты становятся общими на весь сайт,
  // а первая же сработавшая ловушка гасит сайт для всех на сутки.
  // Конфигурация без неё теперь не стартует в проде.
  line('TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128')
  // Годовой HSTS необратим для тех, кто его получил. Пока сертификат
  // и автопродление не проверены, пять минут — правильное значение.
  line('HSTS_MAX_AGE=300')
  line('')
  line('Необязательное:')
  line('  TRUSTED_HOSTS=127.0.0.1        — если мониторинг ходит по адресу, а не по имени')
  line('  YANDEX_OAUTH_TOKEN=<токен>     — без него экран «Аналитика» в админке пуст')
  line('')
  line(`Секретный адрес админки: https://www.prohvac.uz/${adminPath}`)
  line('Он не восстанавливается из базы — сохраните его вместе с секретами.')
  line('')
  line('TELEGRAM_API_BASE в проде НЕ задавать: конфиг откажется стартовать,')
  line('и это защита — заглушка в проде означала бы потерянные заявки.')
  line('')
  line('ПОСЛЕ ВЫКЛАДКИ, когда домен и сертификат уже работают:')
  line('  1. в админке → Настройки → «Подключить кнопки статуса»;')
  line('     без этого шага кнопки смены статуса в чате не работают вовсе;')
  line('  2. node scripts/verify-live.mjs https://www.prohvac.uz')
  line('     (с TELEGRAM_BOT_TOKEN в окружении — тогда проверится и вебхук);')
  line('  3. поднять HSTS_MAX_AGE до 86400, через неделю — до 31536000.')
}

// --- Проверка конфигурации -------------------------------------------------

line('')
line('Проверка конфигурации в режиме production…')

const probe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const m = await import('./server/config.js'); m.assertProductionConfig(); console.log('OK')`,
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  }
)

const failed = probe.status !== 0
if (failed) {
  // Из вывода нужна только причина: оператору важно, чего не хватает, а не
  // по каким файлам прошёл импорт. Node печатает исходную строку throw, стек
  // и свою версию — берём блок от 'Error:' до первой пустой строки.
  const rows = `${probe.stderr || ''}${probe.stdout || ''}`.split('\n')
  const first = rows.findIndex((row) => row.startsWith('Error:'))
  const tail = first === -1 ? rows : rows.slice(first)
  const blank = tail.findIndex((row, index) => index > 0 && row.trim() === '')
  const reason = (blank === -1 ? tail : tail.slice(0, blank))
    .filter((row) => !row.trim().startsWith('at '))
    .join('\n')
    .replace(/^Error:\s*/, '')
    .trim()
  line(reason || 'конфигурация отклонена без сообщения')
  line('')
  line('Это ожидаемо, если переменные ещё не выставлены в текущей оболочке.')
  line('Задайте их и повторите:  node scripts/prepare-production.mjs --check')
} else {
  line('конфигурация принята — процесс с такими переменными стартует')
}

// --- Что осталось сделать руками -------------------------------------------

line('')
line('Дальше по docs/DEPLOYMENT.md:')
line('  1. npm ci && npm run ci               — все проверки, включая smoke:telegram')
line('  2. npm run build:release              — архив релиза')
line('  3. node scripts/verify-release.mjs release/prohvac-release.tar.gz')
line('  4. DATA_DIR завести вне document root, права те же, что у процесса Node')
line('  5. node scripts/seed-content.mjs --dry-run, затем без флага (первый деплой)')
line('  6. node scripts/admin-cli.mjs create-user --username <имя>  — первый админ')
line('  7. Проверить: /, несуществующий URL = 404, секретный адрес админки, вход,')
line('     2FA, заявка в тестовый чат')
line('')
line('Яндекс.Метрика: ANALYTICS_ENABLED=1, цели form_submit и phone_click заведены,')
line('запись всех полей в Вебвизоре выключена. На странице админки счётчика быть')
line('не должно — проверить во вкладке Network, что запросов к mc.yandex.ru нет.')

process.exit(failed && checkOnly ? 1 : 0)
