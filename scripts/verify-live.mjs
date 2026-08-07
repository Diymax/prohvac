// Проверка БОЕВОГО сайта после выкладки.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Все остальные проверки проекта локальные:
// production-smoke поднимает app.cjs у себя с временными секретами,
// release-smoke распаковывает архив во временный каталог, telegram-smoke
// ходит в заглушку. Ни одна из них не отвечает на вопрос, который на самом
// деле волнует после выката: работает ли ТОТ процесс, с ТЕМИ переменными,
// на ТОМ домене. Ошибки развёртывания в этом проекте почти все бесшумные —
// не выставленный ANALYTICS_ENABLED, не зарегистрированный вебхук,
// не заданный TRUSTED_PROXY_CIDRS, — то есть сайт выглядит рабочим и молчит.
//
// Скрипт ТОЛЬКО ЧИТАЕТ. Он не отправляет заявок, не создаёт сообщений в чате
// и не меняет настроек: его безопасно запускать по боевому адресу сколько
// угодно раз.
//
// Запуск:
//   node scripts/verify-live.mjs https://www.prohvac.uz
//
// Проверку вебхука Telegram скрипт делает, только если ему дали токен:
//   TELEGRAM_BOT_TOKEN=... node scripts/verify-live.mjs https://www.prohvac.uz
// Токен нужен для getWebhookInfo — единственного способа узнать снаружи,
// подключены ли кнопки статуса в чате.

import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { METRICA_COUNTER_ID } from '../shared/analytics.js'

const origin = process.argv[2]
if (!origin) {
  console.error('Укажите адрес: node scripts/verify-live.mjs https://www.prohvac.uz')
  process.exit(2)
}

let base
try {
  base = new URL(origin).origin
} catch {
  console.error(`Не похоже на адрес: ${origin}`)
  process.exit(2)
}

const TIMEOUT_MS = 15_000

const results = []

const record = (level, name, passed, detail = '') => {
  results.push({ level, name, passed, detail })
  const mark = passed ? ' ok ' : level === 'warn' ? 'warn' : 'FAIL'
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Обязательное требование: провал означает «выкладку чинить». */
const must = (name, passed, detail) => record('must', name, passed, detail)
/** Желательное: провал стоит увидеть, но сайт работает. */
const should = (name, passed, detail) => record('warn', name, passed, detail)

const section = (title) => console.log(`\n${title}`)

const fetchSafe = async (url, options = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { redirect: 'manual', signal: controller.signal, ...options })
  } catch (error) {
    return { error }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Публичная страница
// ---------------------------------------------------------------------------

section(`Публичная страница ${base}`)

const home = await fetchSafe(base, { headers: { Accept: 'text/html' } })
if (home.error) {
  must('главная отвечает', false, home.error.message)
  console.log('\nДальше идти некуда: сайт недоступен.')
  process.exit(1)
}

must('главная отвечает 200', home.status === 200, `HTTP ${home.status}`)

const html = await home.text()
const csp = home.headers.get('content-security-policy') || ''

must('отдаётся HTML', (home.headers.get('content-type') || '').includes('text/html'))
must('есть Content-Security-Policy', csp.length > 0)
must('в script-src нет unsafe-inline', !/script-src[^;]*'unsafe-inline'/.test(csp))
must('есть X-Content-Type-Options: nosniff', home.headers.get('x-content-type-options') === 'nosniff')
must('есть X-Frame-Options: DENY', (home.headers.get('x-frame-options') || '').toUpperCase() === 'DENY')
// Баннер платформы. Наш процесс не ставит ни Server, ни X-Powered-By — оба
// приходят от nginx и Passenger, а до них из приложения не дотянуться: на
// общем хостинге это правится только директивами вебсервера в панели.
// Поэтому предупреждение, а не отказ: раскрытие версии сайт не ломает, и
// останавливать из-за него выкладку нечего.
const banner = [home.headers.get('server'), home.headers.get('x-powered-by')].filter(Boolean).join(' ')
should('сервер не представляется', !banner,
  banner && `${banner} — убирается в Plesk: Apache и nginx → дополнительные директивы nginx`)

// HSTS. Заголовок имеет смысл только по https, поэтому по http его отсутствие
// не ошибка — иначе скрипт нельзя было бы навести на стенд.
const isHttps = base.startsWith('https://')
const hsts = home.headers.get('strict-transport-security') || ''
if (isHttps) {
  must('есть Strict-Transport-Security', hsts.length > 0)
  // Годовой срок необратим для тех, кто его уже получил: понизить max-age
  // задним числом у побывавшего посетителя невозможно. На первой выкладке,
  // пока сертификат и автопродление не проверены, это скорее риск.
  const maxAge = Number((/max-age=(\d+)/.exec(hsts) || [])[1] || 0)
  should(
    'HSTS не выставлен на год до проверки сертификата',
    maxAge > 0 && maxAge <= 86_400,
    maxAge > 86_400
      ? `max-age=${maxAge}: откатить это у уже побывавших посетителей невозможно. ` +
        'На первой выкладке разумно 300, через неделю 86400, и только потом год'
      : `max-age=${maxAge}`
  )
} else {
  should('проверка идёт по https', false, 'по http часть проверок (HSTS) пропущена')
}

// Nonce обязан быть свой на каждый ответ: одинаковый означает закешированную
// оболочку, то есть CSP, которую можно предсказать.
const nonceOf = (text) => (/nonce="([^"]+)"/.exec(text) || [])[1] || ''
const second = await fetchSafe(base, { headers: { Accept: 'text/html' } })
const secondHtml = second.error ? '' : await second.text()
must('nonce свой на каждый ответ', Boolean(nonceOf(html)) && nonceOf(html) !== nonceOf(secondHtml))
must('плейсхолдер nonce подставлен', !html.includes('__CSP_NONCE__'))

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------
//
// A separate check because this failure is invisible from everywhere else. The
// files live in DATA_DIR, which a deploy deliberately never touches, so on a
// first deploy nobody puts them there. The database still references them, the
// page answers 200, the deploy is green, and only a human looking at the site
// notices empty frames where the project photographs belong.

section('Media library')

const content = await fetchSafe(`${base}/api/site/content?lang=ru`, {
  headers: { Accept: 'application/json' },
})
if (content.error || content.status !== 200) {
  must('site content is served', false, content.error ? content.error.message : `HTTP ${content.status}`)
} else {
  const contentText = await content.text()
  const referenced = [...new Set(contentText.match(/\/media\/[A-Za-z0-9._-]+/g) || [])]
  must('site content is served', true, `media references: ${referenced.length}`)

  const broken = []
  for (const path of referenced) {
    const asset = await fetchSafe(`${base}${path}`)
    const type = asset.error ? '' : asset.headers.get('content-type') || ''
    if (asset.error || asset.status !== 200 || !type.startsWith('image/')) {
      broken.push(`${path} -> ${asset.error ? asset.error.message : asset.status}`)
    }
  }
  must(
    'every referenced image is served',
    referenced.length > 0 && broken.length === 0,
    referenced.length === 0
      ? 'content references no image at all - it looks unpopulated'
      : broken.length === 0
        ? `${referenced.length} files`
        : `${broken.length} of ${referenced.length} missing: ${broken.slice(0, 3).join(', ')}` +
          ' - the files are copied into DATA_DIR/media separately from the release'
  )
}

// ---------------------------------------------------------------------------
// Яндекс.Метрика
// ---------------------------------------------------------------------------

section('Яндекс.Метрика')

const counterOnHome = html.includes('mc.yandex.ru') && html.includes(String(METRICA_COUNTER_ID))
must(
  'счётчик есть на публичной странице',
  counterOnHome,
  counterOnHome ? `id ${METRICA_COUNTER_ID}` : 'не выставлен ANALYTICS_ENABLED=1 — аналитики нет вовсе'
)
must('CSP пропускает счётчик', csp.includes('mc.yandex.ru'))
should('CSP пропускает записи Вебвизора', csp.includes('mc.webvisor.org'),
  'без этого домена записи сеансов собираются, но не доходят')

// ---------------------------------------------------------------------------
// Ответы на несуществующее
// ---------------------------------------------------------------------------

section('Маскировка и границы')

const missPath = `/${randomBytes(8).toString('hex')}`
const miss = await fetchSafe(`${base}${missPath}`, { headers: { Accept: 'text/html' } })
const missHtml = miss.error ? '' : await miss.text()

must('несуществующий путь отвечает 404', miss.status === 404, `HTTP ${miss.status}`)
must('на 404 счётчика нет', !missHtml.includes('mc.yandex.ru'),
  'иначе секретный путь админки попадёт в отчёты Метрики')

const legacy = await fetchSafe(`${base}/admin`, { headers: { Accept: 'text/html' } })
must('предсказуемый /admin закрыт', legacy.status === 404, `HTTP ${legacy.status}`)

// Чужое имя хоста: защита от DNS rebinding.
//
// Через fetch() эту проверку сделать нельзя: Host — запрещённый заголовок,
// среда его молча выбрасывает, и запрос уходит с правильным именем. Поэтому
// запрос собирается вручную через node:http(s); для TLS имя в SNI остаётся
// настоящим, подменяется только заголовок — ровно так выглядит атака.
const rebind = await new Promise((resolve) => {
  const url = new URL(base)
  const request = (isHttps ? httpsRequest : httpRequest)(
    {
      host: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: '/',
      method: 'GET',
      servername: url.hostname,
      headers: { Host: 'evil.invalid', Accept: 'text/html' },
      timeout: TIMEOUT_MS,
    },
    (response) => {
      response.resume()
      resolve({ status: response.statusCode, csp: response.headers['content-security-policy'] || '' })
    }
  )
  request.on('error', () => resolve(null))
  request.on('timeout', () => {
    request.destroy()
    resolve(null)
  })
  request.end()
})
// Отвергнуть чужое имя может кто угодно из двух, и оба исхода одинаково
// хороши. Само приложение отвечает 421, а на общем хостинге запрос до него
// просто не доходит: имя виртуального хоста nginx выбирает по этому же
// заголовку и отдаёт запрос дефолтной заглушке панели. Поэтому смотрим не на
// код ответа, а на то, что ответило НЕ наше приложение, — CSP мы ставим на
// каждый свой ответ, и у чужой страницы его нет.
must(
  'чужой Host до приложения не доходит',
  rebind !== null && (rebind.status === 421 || rebind.status === 404 || !rebind.csp),
  rebind === null ? 'запрос не прошёл' : `HTTP ${rebind.status}${rebind.csp ? ' и ответ от нашего приложения' : ''}`
)

// ---------------------------------------------------------------------------
// Вебхук Telegram
// ---------------------------------------------------------------------------

section('Вебхук Telegram')

const webhookPath = '/api/telegram/webhook'

const webhookGet = await fetchSafe(`${base}${webhookPath}`, { headers: { Accept: 'text/html' } })
must('вебхук не отвечает на GET', webhookGet.status === 404, `HTTP ${webhookGet.status}`)

const webhookNoSecret = await fetchSafe(`${base}${webhookPath}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ update_id: 0 }),
})
must(
  'вебхук без секрета неотличим от несуществующего пути',
  webhookNoSecret.status === 404,
  `HTTP ${webhookNoSecret.status}`
)

const botToken = process.env.TELEGRAM_BOT_TOKEN || ''
if (!botToken) {
  should(
    'регистрация вебхука проверена',
    false,
    'нет TELEGRAM_BOT_TOKEN в окружении — не смогли спросить у Telegram. ' +
      'Без регистрации кнопки статуса в чате не работают вовсе'
  )
} else {
  const info = await fetchSafe(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = info.error ? null : await info.json().catch(() => null)
  const result = data?.result

  must('Telegram принял токен', Boolean(data?.ok), data?.description || info.error?.message || '')

  if (result) {
    const expected = `${base}${webhookPath}`
    must('вебхук зарегистрирован на этот сайт', result.url === expected,
      result.url ? `сейчас ${result.url}` : 'не зарегистрирован — нажмите «Подключить кнопки статуса» в настройках')
    // Растущая очередь означает, что Telegram шлёт, а мы не принимаем:
    // самый частый случай — заблокированный общий ipHash (TRUSTED_PROXY_CIDRS).
    should('очередь необработанных обновлений пуста', (result.pending_update_count ?? 0) === 0,
      `в очереди ${result.pending_update_count}`)
    should('последняя доставка прошла без ошибки', !result.last_error_message,
      result.last_error_message || '')
  }
}

// ---------------------------------------------------------------------------
// Приём заявок
// ---------------------------------------------------------------------------

section('Приём заявок')

// Намеренно негодное тело: проверяем, что эндпоинт жив и валидирует вход,
// НЕ создавая заявку. Настоящая заявка ушла бы в рабочий чат.
const badLead = await fetchSafe(`${base}/api/lead`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ name: '', phone: '' }),
})
must('эндпоинт заявок жив и проверяет вход', badLead.status === 400,
  badLead.status === 503 ? 'HTTP 503: бот не настроен или база недоступна' : `HTTP ${badLead.status}`)

const wrongOrigin = await fetchSafe(`${base}/api/lead`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
  body: JSON.stringify({ name: 'x', phone: '998900000000' }),
})
must('заявка с чужого origin отвергается', wrongOrigin.status === 403, `HTTP ${wrongOrigin.status}`)

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.passed && r.level === 'must')
const warned = results.filter((r) => !r.passed && r.level === 'warn')

console.log('')
console.log(`Проверок: ${results.length}, провалов: ${failed.length}, замечаний: ${warned.length}`)

if (failed.length) {
  console.log('\nВыкладка не готова:')
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? `: ${item.detail}` : ''}`)
  process.exit(1)
}

if (warned.length) {
  console.log('\nЗамечания (сайт работает, но стоит поправить):')
  for (const item of warned) console.log(`  - ${item.name}${item.detail ? `: ${item.detail}` : ''}`)
}

console.log('\nБоевой сайт проверен.')
