// Запуск сервера: проверка конфигурации, миграции, listen, корректная остановка.
//
// Файл выполняется при импорте — его грузит app.cjs, стартовый файл Passenger.
// Всё, что можно проверить до первого запроса, проверяется здесь: процесс,
// который не может работать (нет секретов, старый Node), обязан не подняться.
// Поднявшийся и отдающий 500 на каждом маршруте выглядит в панели хостинга
// как «приложение работает», и разбираться в этом приходится по жалобам
// клиентов.
//
// Недоступная база — отдельный случай (CR-041). Она не повод не подниматься:
// сайт без базы обязан отдавать статику и оболочку, а зависимые от неё API —
// честный 503. Схему накатываем здесь и сейчас, но неудача не фатальна:
// инициализатор рантайма (server/app.js) повторит попытку сам.
//
// Всеми таймерами, фоновыми задачами и порядком остановки владеет один
// lifecycle manager (CR-038) — см. server/application/lifecycle.js.

import { createServer } from 'node:http'

import { createDeliveryRecoveryService } from './application/delivery-recovery.js'
import { createLifecycle } from './application/lifecycle.js'
import { handleRequest, stopRuntimeInitialization } from './app.js'
import { assertProductionConfig, config } from './config.js'
import { closeDb, getDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { claimMaintenance, runCompaction, runMaintenanceAsync } from './lib/maintenance.js'
import { createTranslateWorker } from './translate/worker.js'

// Клиент прислал заголовки не полностью. Медленный мобильный интернет
// укладывается в секунды, а десятки открытых соединений «по байту в минуту» —
// это классический slowloris, выедающий пул процессов Passenger.
const HEADERS_TIMEOUT_MS = 20_000

// Потолок на весь запрос целиком. Самая долгая операция здесь — обращение
// к Telegram с собственным таймаутом в 8 секунд, так что 30 — это запас
// на медленную загрузку тела, а не рабочее значение.
const REQUEST_TIMEOUT_MS = 30_000

// Больше, чем keep-alive у nginx перед нами (обычно 60 с). Иначе гонка:
// прокси отправляет запрос ровно в тот момент, когда мы закрываем соединение
// со своей стороны, и клиент получает 502 на пустом месте.
const KEEP_ALIVE_TIMEOUT_MS = 65_000

// Сколько ждём завершения текущих запросов при остановке. Passenger шлёт
// SIGTERM и через некоторое время добивает процесс SIGKILL, поэтому пауза
// должна быть заметно короче его терпения.
const SHUTDOWN_GRACE_MS = 10_000

// Сколько ждём завершения фоновой работы (проход очереди перевода, уборка).
// Меньше грейса на соединения: фоновая задача, в отличие от запроса, никого
// не ждёт на том конце, а её незавершённость разбирается арендой при старте.
const DRAIN_TIMEOUT_MS = 5_000

// Падает с внятным списком, если в проде не хватает секретов или в них
// осталась дев-заглушка. До listen: сервер без ключей не должен принимать
// ни одного запроса.
assertProductionConfig()

// Миграции здесь, а не при первом обращении к базе: процессов в пуле
// несколько, и «накатить схему на первом запросе» означало бы гонку четырёх
// процессов на старте. Раннер идемпотентен и берёт BEGIN IMMEDIATE, поэтому
// одновременный запуск безопасен — второй просто увидит запись в журнале.
try {
  const applied = runMigrations(getDb())
  if (applied.length) console.log(`[boot] применены миграции: ${applied.join(', ')}`)
} catch (error) {
  // CR-041. Раньше здесь процесс умирал, и сбой диска гасил сайт целиком —
  // включая статику, которой база не нужна вовсе. Теперь поднимаемся: рантайм
  // повторит открытие базы и миграции по backoff, зависимые от базы API до
  // этого отвечают 503 с Retry-After.
  console.error(
    `[boot] база недоступна на старте: ${error.message}. ` +
    'Поднимаемся в ограниченном режиме: статика отдаётся, API возвращают 503.'
  )
}

const server = createServer(handleRequest)

server.headersTimeout = HEADERS_TIMEOUT_MS
server.requestTimeout = REQUEST_TIMEOUT_MS
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS

server.on('error', (error) => {
  console.error('[boot] сервер не поднялся:', error.message)
  // Явный выход, а не process.exitCode: сокет мог остаться в промежуточном
  // состоянии и удерживать цикл событий, и процесс висел бы «живым» навсегда.
  process.exit(1)
})

// Единственный владелец таймеров, фоновых задач и порядка остановки.
const lifecycle = createLifecycle({
  drainTimeoutMs: DRAIN_TIMEOUT_MS,
  closeTimeoutMs: SHUTDOWN_GRACE_MS,
})

// Соединение с базой открывается лениво, поэтому и воркер, и служба
// восстановления создаются при первом проходе, а не на импорте: иначе
// недоступная на старте база снова роняла бы процесс (CR-041).
let translator = null
const getTranslator = () => (translator ??= createTranslateWorker(getDb()))

let deliveryRecovery = null
const getDeliveryRecovery = () =>
  (deliveryRecovery ??= createDeliveryRecoveryService({ db: getDb() }))

/**
 * Остановка по сигналу.
 *
 * Порядок задан в lifecycle: перестать принимать новое -> снять таймеры ->
 * отменить внешние запросы -> дождаться фоновых задач -> отпустить аренды ->
 * закрыть HTTP-сервер -> закрыть базу.
 *
 * closeDb() последним и обязателен. При journal_mode=WAL незакрытое соединение
 * оставляет на диске app.sqlite-wal и app.sqlite-shm: следующий процесс их
 * подхватит и восстановится, но контрольная точка не выполнена, файл WAL
 * растёт от перезапуска к перезапуску, а на 500 МБ диска это заметно.
 */
lifecycle.onStopIntake('runtime', () => stopRuntimeInitialization())

lifecycle.onRelease('translate', async () => {
  // Аренда очереди и резервы квоты живут в базе. Не отпустить их — значит
  // заставить следующий процесс ждать истечения TTL на пустом месте.
  if (translator) await translator.stop({ timeoutMs: DRAIN_TIMEOUT_MS })
})

lifecycle.onCloseServer(
  () =>
    new Promise((resolve) => {
      // Незаметно для клиента закрываем соединения, по которым сейчас ничего
      // не передаётся: без этого server.close() ждёт истечения keep-alive,
      // то есть всю минуту с лишним, и Passenger успевает прислать SIGKILL.
      server.closeIdleConnections()
      server.close((error) => {
        if (error) console.error('[boot] server.close:', error.message)
        resolve()
      })
    }),
  { force: () => server.closeAllConnections() }
)

lifecycle.onCloseDatabase(() => closeDb())

// SIGTERM/SIGINT, повторный сигнал и политика по unhandledRejection —
// см. server/application/lifecycle.js. Необработанный rejection больше
// не глотается: процесс с оборванной цепочкой промисов дописывает
// обеззараженный диагностический след, останавливается штатно и выходит
// с ненулевым кодом, чтобы Passenger поднял чистый.
lifecycle.attachProcessSignals()

// Под Passenger порт из PORT — формальность: загрузчик подменяет listen()
// и сажает приложение на свой сокет. Значение важно при прямом запуске
// (локальная проверка боевой сборки, сквозные тесты).
server.listen(config.port, () => {
  console.log(`[boot] PROHVAC слушает порт ${config.port}, режим ${config.nodeEnv}`)
})

// Периодический проход очереди перевода.
//
// Без него задача, ушедшая в deferred (провайдер недоступен, 429, сеть,
// исчерпанная квота), лежала бы до следующей случайной правки текста:
// единственным триггером был setImmediate после постановки. А задача,
// застрявшая в running после рестарта Passenger, не разбиралась бы никогда
// и продолжала занимать частичный уникальный индекс.
//
// Аренда в app_state уже разводит процессы пула, поэтому таймер в каждом
// из них безопасен: работу возьмёт ровно один.
const TICK_INTERVAL_MS = 60_000

// CR-032. Восстановление зависших попыток доставки идёт тем же тиком, что и
// очередь перевода: обе задачи разводятся арендой в app_state, поэтому таймер
// в каждом процессе пула безопасен. Проход на старте обязателен — процесс мог
// упасть ровно между успехом Telegram и фиксацией результата.
const runTick = async ({ signal }) => {
  try {
    const recovered = getDeliveryRecovery().run()
    if (recovered.recovered) {
      console.warn(
        `[delivery] восстановлено зависших попыток: ${recovered.recovered}. ` +
        'Состояние delivery_unknown — повтор только после подтверждения оператора.'
      )
    }
  } catch (error) {
    console.error('[delivery] восстановление не удалось:', error.message)
  }

  try {
    const worker = getTranslator()
    const revived = worker.recover()
    if (revived) console.log(`[translate] возвращено в очередь зависших задач: ${revived}`)
    // signal приходит от lifecycle: остановка процесса обрывает запрос
    // к провайдеру перевода, а не ждёт его доброй воли.
    await worker.tick({ signal })
  } catch (error) {
    console.error('[translate] проход очереди не удался:', error.message)
  }
}

// Первый проход через 5 секунд после старта — добираем то, что осталось
// с прошлой жизни процесса.
lifecycle.every('tick', runTick, { intervalMs: TICK_INTERVAL_MS, firstRunDelayMs: 5_000 })

// Уборка базы.
//
// Раньше она существовала единственной командой `admin-cli gc`, то есть
// выполнялась ровно тогда, когда о ней вспоминали по SSH. Цена пропуска —
// не только диск: leads.purge_after объявляет СРОК ХРАНЕНИЯ персональных
// данных, и наступать он обязан сам.
//
// Право на проход разыгрывает claimMaintenance() через аренду в
// maintenance_state, поэтому таймер в каждом процессе пула безопасен: работу
// возьмёт ровно один. Расписание при этом разведено по смыслу (CR-043):
// захват двигает следующий запуск на срок аренды, успех — на сутки, отказ —
// на короткий backoff. Раньше все три случая писали одну и ту же отметку,
// и процесс, упавший сразу после захвата, глушил уборку на сутки — то есть
// срок хранения ПДн из leads.purge_after не наступал.
const MAINTENANCE_CHECK_MS = 60 * 60_000

const runMaintenanceTick = async () => {
  try {
    if (!claimMaintenance(getDb())) return

    // Асинхронный вариант: пачки удаления отдают управление event loop между
    // собой, иначе уборка на большой базе держит процесс и запросы ждут.
    const result = await runMaintenanceAsync(getDb())
    console.log(
      `[maintenance] заявок ${result.leads}, попыток входа ${result.loginAttempts}, ` +
      `блокировок ${result.ipBlocks}, аудита ${result.auditLog}, ` +
      `задач перевода ${result.translationJobs}, счётчиков ${result.rateLimit}, ` +
      `сессий ${result.sessions.deleted}, за ${Math.round(result.durationMs)} мс` +
      (result.truncated ? ' (проход неполный, продолжение — по короткому повтору)' : '')
    )

    // Свернуть WAL после массовых удалений: без контрольной точки файл журнала
    // остаётся раздутым, а на 500 МБ диска это заметно. Отдельная аренда и
    // отдельный замер: checkpoint — самая долгая часть уборки.
    const compaction = runCompaction(getDb())
    if (compaction.ran && !compaction.checkpointed) {
      console.warn('[maintenance] WAL не удалось свернуть: база занята другим процессом')
    }
  } catch (error) {
    // Уборка не должна ронять процесс: сайт работает и с непочищенной базой,
    // а вот молчаливый сбой однажды уже означал, что ПДн копились бессрочно.
    console.error('[maintenance] уборка не удалась:', error.message)
  }
}

// Со сдвигом относительно первого прохода очереди перевода: два тяжёлых
// прохода в одну секунду на старте пула — лишняя нагрузка на ровном месте.
lifecycle.every('maintenance', runMaintenanceTick, {
  intervalMs: MAINTENANCE_CHECK_MS,
  firstRunDelayMs: 30_000,
})

export { lifecycle, server }
