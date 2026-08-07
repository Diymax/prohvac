import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

import { attachResponseHelpers } from './shared/http-compat.js'
import { stripAnalyticsMarkup } from './shared/analytics-markup.js'

// Серверные переменные (без префикса VITE_) Vite в import.meta.env не кладёт —
// прокидываем их в process.env. Иначе продовый роутер поднимется в dev
// с пустым конфигом: server/config.js читает ровно process.env и ничего
// не знает про .env-файлы Vite.
const SERVER_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_API_BASE',
  'ALLOWED_ORIGINS',
  'APP_SECRET',
  'GATE_SECRET',
  'ADMIN_SECRET_PATH',
  'DATA_DIR',
  'PUBLIC_ORIGIN',
  'TRUSTED_PROXY_CIDRS',
  'DEEPL_API_KEY',
]

// Пути, которые в проде обслуживает сервер, а не файл на диске: API, переводы
// (следующий этап отдаёт их из content_entries) и медиа из DATA_DIR.
//
// Остальное в dev остаётся за Vite, и это не компромисс, а необходимость:
// продовый роутер доигрывает любой неизвестный путь статикой из dist/
// и собранной оболочкой. В dev это отдало бы браузеру прошлую сборку вместо
// index.html с HMR-клиентом и модулями из src.
const SERVER_PATHS = /^\/(api|locales|media)(\/|$)/

/**
 * Поднимает ПРОДОВЫЙ роутер (server/app.js) прямо в dev-сервере Vite.
 *
 * Раньше здесь монтировался отдельный экземпляр конвейера заявки, то есть dev
 * исполнял свою копию серверного поведения: нормализация пути, заголовки
 * безопасности, порядок маршрутов существовали только после деплоя.
 * Теперь точка входа одна и та же — handleRequest из server/app.js, —
 * поэтому разойтись dev и проду больше негде.
 */
/**
 * Вырезает счётчик Метрики из страницы, которую отдаёт dev-сервер.
 *
 * ЗАЧЕМ. Всё, кроме '/api', '/locales' и '/media', отдаёт Vite — он берёт
 * index.html из корня репозитория как есть. А счётчик в этом файле стоит
 * безусловно, потому что вырезанием занимается продовая оболочка
 * (server/http/spa.js), до которой dev-запрос не доходит. Последствий два,
 * и второе серьёзнее первого:
 *
 *   1. каждый `npm run dev` и каждый прогон браузерных тестов слал реальные
 *      просмотры в боевой счётчик 111268288 — статистика сайта включала
 *      разработку;
 *   2. SPA-фолбэк Vite отдаёт ту же страницу и на секретном пути админки,
 *      то есть Вебвизор записывал локальную панель, а сам путь попадал
 *      в отчёт «Страницы входа». Ровно та утечка, ради которой в проде
 *      существует разделение sendSpa / sendPublicShell.
 *
 * ANALYTICS_ENABLED здесь не спрашивается намеренно: в dev счётчик не нужен
 * никогда, а «включил флаг и случайно записал админку» — не та возможность,
 * которую стоит оставлять.
 */
const stripAnalyticsPlugin = () => ({
  name: 'analytics-dev-strip',
  apply: 'serve',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) => stripAnalyticsMarkup(html),
  },
})

const apiDevPlugin = () => ({
  name: 'api-dev',
  apply: 'serve',
  configureServer(server) {
    // Схему накатываем один раз, перед первым обращением к серверным
    // маршрутам. В проде это делает server/index.js до listen, а в dev точки
    // старта нет вовсе: без миграций каждый запрос упирается в отсутствующие
    // таблицы и сыплет в лог ошибками вместо работы.
    //
    // Лениво, а не при старте сервера: пока правят только фронтенд, файл базы
    // на диске незачем создавать.
    let schemaReady = null
    const ensureSchema = () => {
      if (schemaReady) return schemaReady

      schemaReady = (async () => {
        const [{ getDb }, { runMigrations }] = await Promise.all([
          server.ssrLoadModule('/server/db/index.js'),
          server.ssrLoadModule('/server/db/migrate.js'),
        ])
        const applied = runMigrations(getDb())
        if (applied.length) {
          server.config.logger.info(`[api-dev] применены миграции: ${applied.join(', ')}`)
        }
      })().catch((error) => {
        // Одна внятная строка вместо ошибки на каждом запросе. Повторных
        // попыток нет намеренно: причина (слишком старый Node, нет прав
        // на DATA_DIR) сама не рассосётся, а вёрстку в dev это не блокирует.
        server.config.logger.warn(`[api-dev] схема не готова: ${error.message}`)
      })

      return schemaReady
    }

    // Регистрация НАПРЯМУЮ, а не через возвращаемый колбэк. Возвращаемый
    // колбэк ставит middleware post-order — после внутренних middleware Vite,
    // и раздача public/ перехватывала бы запрос раньше нас: public/locales/*.json
    // уезжал бы клиенту с диска, а динамический обработчик переводов
    // не вызывался бы вовсе, то есть правки контента в dev не видны.
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url || '/').split('?')[0]
      if (!SERVER_PATHS.test(path)) return next()

      // Тот же полифилл ответа, что и в проде (shared/http-compat.js):
      // конвейер заявки ждёт res.status().json(), которых у голого
      // ServerResponse нет. Вызов идемпотентный, поэтому повторное
      // навешивание внутри роутера безвредно.
      attachResponseHelpers(res)

      const isApi = path === '/api' || path.startsWith('/api/')

      // Единый разбор сбоя: сюда приходит и брошенное исключение, и вызов
      // next(error) — так handleRequest сообщает о внутренней ошибке.
      const onFailure = (error) => {
        server.config.logger.error(
          `[api-dev] ${req.method} ${req.url}\n${error?.stack || error}`
        )
        if (res.writableEnded || res.headersSent) return

        // API обязан отвечать в своём контракте: клиент разбирает JSON
        // и на HTML-странице ошибки Vite споткнётся.
        if (isApi) {
          res.status(500).json({ ok: false, error: 'dev_handler_failed' })
          return
        }

        // Остальное отдаём Vite: поломка серверного модуля не должна
        // превращать дев-сайт в белый экран, причина уже в логе.
        next()
      }

      try {
        await ensureSchema()

        // ssrLoadModule даёт серверному коду то же, что HMR клиентскому:
        // после правки в server/** перезапуск dev-сервера не нужен.
        // Тело запроса намеренно не вычитываем — его читает сам роутер
        // (server/http/body.js), а второй читатель отобрал бы у него поток.
        const mod = await server.ssrLoadModule('/server/app.js')
        const handler = mod.handleRequest || mod.default
        if (typeof handler !== 'function') {
          throw new TypeError(
            'server/app.js должен экспортировать handleRequest(req, res, next)'
          )
        }
        await handler(req, res, onFailure)
      } catch (error) {
        onFailure(error)
      }
    })
  },
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of SERVER_ENV_KEYS) {
    // Уже заданное окружение сильнее .env-файла: значение из командной строки
    // или из панели хостинга не должно затираться локальным файлом.
    if (env[key] && !process.env[key]) process.env[key] = env[key]
  }

  return {
    plugins: [react(), stripAnalyticsPlugin(), apiDevPlugin()],
    test: {
      // release/ — копия исходников под выкладку (scripts/build-release.mjs).
      // Без исключения vitest находит в ней вторые экземпляры тех же тестов
      // и прогоняет весь набор дважды, отчитываясь удвоенным числом.
      exclude: ['node_modules/**', 'dist/**', 'release/**'],
    },
    build: {
      // Имена чанков — только хеш. По умолчанию Vite подставляет имя модуля,
      // и в листинге /assets/ появился бы AdminEntry-XXXX.js: наличие панели
      // видно без единого запроса к ней, а весь смысл секретного пути в том,
      // чтобы её не было заметно.
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[hash].js',
          chunkFileNames: 'assets/[hash].js',
          assetFileNames: 'assets/[hash][extname]',
        },
      },
    },
  }
})
