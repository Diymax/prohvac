// Состояние сессии админки: загрузка текущей, вход паролем, второй фактор,
// выход. Один источник правды на всё приложение — экраны не ходят
// в /api/admin/session сами.
//
// ЧЕТЫРЕ СОСТОЯНИЯ, И БОЛЬШЕ НИКАКИХ:
//   loading   — первый GET ещё идёт, показывать форму входа рано (иначе
//               на каждой перезагрузке страницы мигает логин у вошедшего);
//   anonymous — сессии нет;
//   totp      — пароль принят, ждём второй фактор (промежуточная сессия
//               живёт пять минут и не продлевается, см. admin.auth.js);
//   active    — полноценная сессия.
//
// ПОЧЕМУ ОТСУТСТВИЕ СЕССИИ — НЕ ОШИБКА. Сервер прячет админку: без сессии
// /api/admin/session отвечает 200 и HTML-оболочкой сайта. Клиент (api.js)
// превращает это в код 'not_found', а здесь он трактуется как «не вошли».
// Показывать при этом «ошибка сети» было бы враньём.
//
// ПОРЯДОК ОТВЕТОВ ВАЖНЕЕ ПОРЯДКА ЗАПРОСОВ. Состояние сессии меняют пять
// разных операций, и любая из них может прийти позже той, что её обогнала:
// focus и visibilitychange срабатывают одной парой, вход отвечает медленно
// (сервер выравнивает время), сеть возвращается посреди всего этого.
// Раньше выигрывал ответ, пришедший последним, — то есть иногда свежий вход
// затирался устаревшим GET /session вместе с его CSRF-токеном. Теперь каждая
// операция берёт номер (createSessionSync) и применяет результат, только если
// её номер всё ещё старший; обновление сессии вдобавок single-flight, а все
// запросы хука отменяются одним AbortController при размонтировании.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { frontendError } from '../errors.js'
import { api, setCsrfToken, setSessionLostHandler } from './api.js'

// Пустое состояние. Заводится один раз, чтобы сравнение по ссылке в тестах
// и в devtools показывало «то же самое», а не новый объект каждый раз.
const ANONYMOUS = Object.freeze({
  status: 'anonymous',
  user: null,
  expiresAt: 0,
  mustChangePassword: false,
  totpEnrolled: false,
  amr: '',
  attemptsLeft: 0,
  recoveryRemaining: null,
  capabilities: Object.freeze({}),
})

const LOADING = Object.freeze({ ...ANONYMOUS, status: 'loading' })

// Как часто разрешено перечитывать сессию при возврате на вкладку. Без порога
// alt-tab туда-сюда превращается в поток запросов, а сессия за секунду
// не меняется.
const REFRESH_INTERVAL_MS = 30_000

/**
 * Пользователь в едином виде.
 *
 * Сервер отдаёт username отдельным полем user (строкой) и роль полем role,
 * а описанный контракт админки говорит про вложенный объект {username, role}.
 * Расхождение разбирается здесь ровно один раз: экранам нужен один вид,
 * и подстраиваться под форму ответа в каждом из них — верный способ однажды
 * показать в шапке [object Object].
 */
const normalizeUser = (data) => {
  const raw = data?.user
  if (raw && typeof raw === 'object') {
    return { username: String(raw.username ?? ''), role: String(raw.role ?? data.role ?? '') }
  }
  if (typeof raw === 'string' && raw) return { username: raw, role: String(data.role ?? '') }
  return null
}

/** Ответ сервера → состояние вошедшего пользователя. */
const activeState = (data) => ({
  status: 'active',
  user: normalizeUser(data),
  expiresAt: Number(data.expiresAt) || 0,
  mustChangePassword: data.mustChangePassword === true,
  // totpEnrolled приходит только в ответе на пароль: после второго фактора
  // он очевидно true, а GET /session про привязку не сообщает вовсе.
  totpEnrolled: data.totpEnrolled === true || String(data.amr ?? '').includes('otp'),
  amr: String(data.amr ?? ''),
  attemptsLeft: 0,
  recoveryRemaining: Number.isFinite(data.remaining) ? data.remaining : null,
  capabilities: Object.freeze(
    Object.fromEntries(
      Object.entries(data?.capabilities ?? {}).filter(
        ([key, value]) => typeof key === 'string' && typeof value === 'boolean'
      )
    )
  ),
})

/**
 * Очередь операций над сессией: монотонные номера и single-flight обновление.
 *
 * Вынесено из хука отдельной функцией по двум причинам. Во-первых, это вся
 * логика гонок целиком, и она обязана проверяться тестами без браузера.
 * Во-вторых, у хука не должно быть соблазна «просто применить ответ»: чтобы
 * что-то записать в состояние, нужно сначала получить номер и потом доказать,
 * что он всё ещё старший.
 *
 * @param {{now?: () => number, minIntervalMs?: number}} [options]
 * @returns {object} координатор
 */
export const createSessionSync = ({ now = () => Date.now(), minIntervalMs = REFRESH_INTERVAL_MS } = {}) => {
  let issued = 0
  let applied = 0
  let inFlight = null
  let lastStarted = Number.NEGATIVE_INFINITY
  let disposed = false

  /** Номер новой операции. Ноль — координатор уже закрыт. */
  const ticket = () => (disposed ? 0 : (issued += 1))

  /** Не устарел ли результат операции. */
  const accepts = (value) => !disposed && value > 0 && value > applied

  /** Занять право записи. false — пока ответ шёл, состояние успели поменять. */
  const commit = (value) => {
    if (!accepts(value)) return false
    applied = value
    return true
  }

  /**
   * Обновление сессии. Пока запрос в полёте, все желающие получают его же
   * промис: focus и visibilitychange приходят парой, и второй GET не даёт
   * ничего, кроме второй строки в логе сервера.
   *
   * @param {(ticket: number) => Promise<unknown>} task
   * @param {{force?: boolean}} [options] force игнорирует интервал (возврат
   *   сети, ручная кнопка), но не отменяет single-flight
   */
  const refresh = (task, { force = false } = {}) => {
    if (disposed) return Promise.resolve(null)
    if (inFlight) return inFlight
    if (!force && now() - lastStarted < minIntervalMs) return Promise.resolve(null)

    lastStarted = now()
    const value = ticket()

    // Задача запускается синхронно: запрос должен уйти сейчас, а не в
    // следующем микротаске, иначе между focus и visibilitychange остаётся
    // щель, в которую пролезает второй запрос.
    let started
    try {
      started = Promise.resolve(task(value))
    } catch (error) {
      started = Promise.reject(error)
    }

    let chain
    chain = started.finally(() => {
      if (inFlight === chain) inFlight = null
    })
    inFlight = chain
    return chain
  }

  const dispose = () => {
    disposed = true
    inFlight = null
  }

  return {
    ticket,
    accepts,
    commit,
    refresh,
    dispose,
    get pending() {
      return inFlight !== null
    },
    get disposed() {
      return disposed
    },
  }
}

/**
 * Хук сессии. Ровно один экземпляр на приложение (создаётся в AdminApp).
 *
 * @returns {object} состояние и действия
 */
export const useSession = () => {
  const [state, setState] = useState(LOADING)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Размонтированный компонент не должен получать setState: запросы входа
  // намеренно медленные (сервер выравнивает время ответа), и уйти со страницы
  // за это время успевает кто угодно.
  const alive = useRef(true)
  const syncRef = useRef(null)
  const abortRef = useRef(null)
  // Зеркало статуса для обработчиков, которые вызываются вне рендера
  // (потеря сессии приходит из любого запроса любого экрана).
  const statusRef = useRef(LOADING.status)

  useEffect(() => {
    statusRef.current = state.status
  }, [state.status])

  /**
   * Координатор и сигнал отмены текущего «поколения» хука. Создаются лениво
   * и пересоздаются после размонтирования: в StrictMode React монтирует
   * компонент дважды теми же ref-ами, и закрытый навсегда координатор оставил
   * бы панель в состоянии «загружаем».
   */
  const ensure = useCallback(() => {
    if (!syncRef.current || syncRef.current.disposed) {
      syncRef.current = createSessionSync()
      abortRef.current = new AbortController()
    }
    return { sync: syncRef.current, signal: abortRef.current.signal }
  }, [])

  /**
   * Запись состояния под номером операции.
   *
   * @param {object} sync координатор
   * @param {number} ticket номер операции
   * @param {{token?: string, next?: object, error?: string}} change
   * @returns {boolean} применили или отбросили как устаревшее
   */
  const commitState = useCallback((sync, ticket, change) => {
    if (!alive.current || !sync.commit(ticket)) return false

    // Токен пишется только вместе с состоянием и только выигравшей операцией:
    // иначе отставший ответ возвращал бы CSRF-токен предыдущей сессии,
    // и первая же мутация после входа падала бы с csrf_failed.
    if (change.token !== undefined) setCsrfToken(change.token)
    if (change.next) setState(change.next)
    setError(change.error ?? '')
    return true
  }, [])

  /** Ответ сервера с сессией → состояние. */
  const applyData = useCallback(
    (sync, ticket, data) => commitState(sync, ticket, { token: data.csrfToken, next: activeState(data) }),
    [commitState]
  )

  /** Локальный выход: сессии нет, токен не нужен. */
  const forget = useCallback(
    (sync, ticket, reason = '') =>
      commitState(sync, ticket, { token: '', next: ANONYMOUS, error: reason }),
    [commitState]
  )

  const refresh = useCallback(
    (options) => {
      // По умолчанию — принудительно: явный вызов из экрана означает «проверь
      // сейчас», и молча не сделать ничего было бы худшим из ответов.
      // Интервал соблюдают только фоновые поводы, передающие force: false.
      // Проверка через !== false, а не деструктуризацию: refresh нередко
      // передают прямо в onClick, и первым аргументом приходит событие.
      const force = options?.force !== false
      const { sync, signal } = ensure()
      return sync.refresh(
        async (ticket) => {
          try {
            const data = await api.get('/session', { signal })

            // {ok:true, authenticated:false} означает «панель доступна, но вы
            // не вошли». Это НЕ сессия: без этой ветки интерфейс рисовал каркас
            // с меню и кнопкой «Выйти» человеку, который не вводил пароль.
            // Данные при этом не текли — их не отдаёт сервер, — но выглядело так,
            // будто вход не нужен вовсе.
            if (data?.authenticated === false || !data?.user) {
              // Незавершённый вход после перезагрузки вкладки продолжаем с того же
              // места: сервер отдаёт стадию и свежий CSRF-токен, и терять их
              // означало бы отправлять человека вводить пароль заново.
              if (data?.stage === 'totp' || data?.stage === 'enroll') {
                commitState(sync, ticket, {
                  token: data.csrfToken,
                  next: {
                    ...ANONYMOUS,
                    status: data.stage,
                    expiresAt: Number(data.expiresAt) || 0,
                  },
                })
                return
              }
              forget(sync, ticket)
              return
            }

            applyData(sync, ticket, data)
          } catch (failure) {
            // Отмена (ушли со страницы, начали заново) — не ошибка: показывать
            // нечего и некому.
            if (failure?.name === 'AbortError') return
            // 'not_found' — сессии нет. Всё остальное (сеть, таймаут) показываем,
            // иначе пользователь получит форму входа и не поймёт, почему пароль
            // «не подходит», когда на самом деле отвалился интернет.
            forget(sync, ticket, failure?.code === 'not_found' ? '' : failure?.code || 'network')
          }
        },
        { force }
      )
    },
    [applyData, commitState, ensure, forget]
  )

  useEffect(() => {
    alive.current = true
    const { sync } = ensure()

    // Пропавшую по дороге сессию ловим глобально: её обнаруживает любой
    // запрос любого экрана, а реакция всегда одна. api.js объявляет её один
    // раз, сколько бы запросов ни упёрлось в просроченную куку.
    const unsubscribe = setSessionLostHandler(() => {
      if (!alive.current) return

      // Номер берётся сейчас, а не при запросе: сервер уже сказал «сессии
      // нет», и этот вердикт свежее всего, что осталось в полёте.
      const ticket = sync.ticket()
      // Причину показываем только тому, кто был внутри. На первом заходе
      // сессии не было вовсе, и «сессия истекла» там — неправда.
      //
      // Без этого сообщения выброс выглядел как поломка: экран привязки
      // второго фактора живёт ограниченное время, и по его истечении
      // нажатие «Подтвердить привязку» молча возвращало на форму входа.
      // Экран, поймавший ошибку, размонтируется вместе со своим текстом,
      // поэтому сказать об этом может только владелец состояния сессии.
      //
      // Статус читается из ref, а не из setState-обновителя: React вправе
      // вызвать обновитель дважды, а тот в прошлой версии сам менял состояние.
      const inside = statusRef.current !== 'anonymous' && statusRef.current !== 'loading'
      forget(sync, ticket, inside ? 'session_lost' : '')
    })

    refresh({ force: true })

    return () => {
      alive.current = false
      // Всё, что ещё в полёте, отменяется: ответ уже некому применять,
      // а необорванный запрос входа держит соединение до самого таймаута.
      abortRef.current?.abort()
      sync.dispose()
      unsubscribe()
    }
  }, [ensure, forget, refresh])

  // Вернулись на вкладку — проверяем, жива ли сессия. Окно бездействия
  // на сервере полчаса, и без этой проверки человек узнаёт об истечении
  // только по неудачному сохранению уже набранного текста.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return
      // focus и visibilitychange приходят парой; интервал и single-flight
      // превращают эту пару в один запрос.
      refresh({ force: false })
    }

    // Вернувшаяся сеть — отдельный случай: интервал здесь ни при чём,
    // проверить сессию нужно сразу, но по-прежнему одним запросом.
    const onOnline = () => refresh({ force: true })

    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('online', onOnline)
    }
  }, [refresh])

  /** Общая обёртка действия: занятость, единый разбор ошибки, защита от гонок. */
  const run = useCallback(async (action) => {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      return { ok: true, data: result }
    } catch (failure) {
      if (alive.current && failure?.name !== 'AbortError') setError(failure.code || 'network')
      return { ok: false, code: failure.code || 'network', error: failure }
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const signIn = useCallback(
    (username, password) =>
      run(async () => {
        const { sync, signal } = ensure()
        const data = await api.post('/session', { username, password }, { signal })
        // Номер берётся ПОСЛЕ ответа, в отличие от обновления сессии.
        // Обновление — вопрос («что там сейчас?»), и его ответ устаревает,
        // если за время полёта состояние изменилось. Вход — утверждение
        // («теперь сессия такая»), и оно свежее любого параллельного вопроса,
        // даже заданного позже: тот видел сервер до входа.
        const ticket = sync.ticket()

        // 'totp'  — приложение привязано, нужен код.
        // 'enroll' — привязки ещё нет, её нужно пройти.
        // Обе стадии НЕ являются входом: сервер такой сессии данных не отдаёт,
        // и интерфейс обязан вести себя так же. Иначе человек видел бы каркас
        // панели с пустым именем и меню, все разделы которого отвечают 404.
        if (data.stage === 'totp' || data.stage === 'enroll') {
          commitState(sync, ticket, {
            token: data.csrfToken,
            next: {
              ...ANONYMOUS,
              status: data.stage,
              // Имя показываем на экране кода: человек должен видеть, в какую
              // учётку он входит, если их несколько.
              user: { username: String(username ?? ''), role: '' },
              expiresAt: Number(data.expiresAt) || 0,
              attemptsLeft: Number.isFinite(data.attemptsLeft) ? data.attemptsLeft : 0,
            },
          })
        } else {
          applyData(sync, ticket, data)
        }
        return data
      }),
    [applyData, commitState, ensure, run]
  )

  /** Второй фактор. path различает код из приложения и код восстановления. */
  const submitSecondFactor = useCallback(
    (path, code) =>
      run(async () => {
        const { sync, signal } = ensure()
        try {
          const data = await api.post(path, { code }, { signal })
          applyData(sync, sync.ticket(), data)
          return data
        } catch (failure) {
          // Пять неудач уничтожают промежуточную сессию: вводить код больше
          // некуда, и держать пользователя на этом экране бессмысленно.
          if (failure.code === 'session_destroyed') forget(sync, sync.ticket())
          else if (alive.current && Number.isFinite(failure.payload?.attemptsLeft)) {
            setState((prev) => ({ ...prev, attemptsLeft: failure.payload.attemptsLeft }))
          }
          throw failure
        }
      }),
    [applyData, ensure, forget, run]
  )

  const submitTotp = useCallback((code) => submitSecondFactor('/session/totp', code), [submitSecondFactor])

  const submitRecovery = useCallback(
    (code) => submitSecondFactor('/session/recovery', code),
    [submitSecondFactor]
  )

  /**
   * Смена пароля. Сервер отвечает тем же, чем и вход: новым CSRF-токеном
   * и представлением сессии, — потому что старая сессия ротируется, а все
   * остальные отзываются. Поэтому applyData(), а не точечная правка состояния:
   * иначе mustChangePassword остался бы true после успешной смены.
   */
  const changePassword = useCallback(
    (current, next) =>
      run(async () => {
        const { sync, signal } = ensure()
        const data = await api.post('/password', { current, next }, { signal })
        applyData(sync, sync.ticket(), data)
        return data
      }),
    [applyData, ensure, run]
  )

  const signOut = useCallback(
    () =>
      run(async () => {
        const { sync, signal } = ensure()
        try {
          // У DELETE нет тела: сервер для него отключает проверку Content-Type,
          // а браузер не отправит лишний заголовок.
          await api.del('/session', { signal })
        } finally {
          // Локально выходим в любом случае. Сессия уже могла истечь, и тогда
          // запрос вернёт «не найдено» — держать после этого интерфейс
          // вошедшего просто неверно. Номер берётся после ответа: выход
          // старше всего, что осталось в полёте.
          forget(sync, sync.ticket())
        }
        return null
      }),
    [ensure, forget, run]
  )

  const clearError = useCallback(() => setError(''), [])

  // Человеческий текст ошибки рядом с её кодом: экранам нужен не сам код,
  // а фраза и подсказка, что делать (см. src/errors.js). Код остаётся
  // в technicalCode — для блока диагностики, а не для заголовка.
  const errorModel = useMemo(() => (error ? frontendError(error) : null), [error])

  return {
    ...state,
    error,
    errorModel,
    busy,
    clearError,
    refresh,
    signIn,
    submitTotp,
    submitRecovery,
    changePassword,
    // Отмена наполовину пройденного входа — это тот же выход: промежуточную
    // сессию надо погасить на сервере, а не просто забыть в браузере.
    cancelPending: signOut,
    signOut,
  }
}
