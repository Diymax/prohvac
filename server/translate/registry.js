// Реестр провайдеров: кто именно переводит конкретный язык прямо сейчас.
//
// Решение зависит от четырёх вещей, и все четыре меняются во времени:
//   1. маршрутизация из settings ('translation.routing') — её правит админ;
//   2. настроен ли провайдер (ключ лежит в settings и может быть стёрт);
//   3. заявляет ли он поддержку языка (у DeepL список приезжает от API);
//   4. не исчерпана ли квота и не идёт ли кулдаун после серии сбоев.
//
// ПОЧЕМУ КУЛДАУН ОБЯЗАТЕЛЕН. Без него сломанный провайдер (истёк ключ, лежит
// сеть) получает каждую задачу очереди, каждый тик, из каждого процесса пула.
// Это не только бесполезный трафик: пока задача упирается в мёртвого DeepL,
// живой MyMemory её не видит, и узбекская версия сайта стоит. Кулдаун снимает
// провайдера с раздачи на растущий срок, и следующий в списке начинает
// работать сам, без вмешательства человека.
//
// Состояние кулдауна — в settings, а не в памяти: у Passenger пул процессов,
// и «сбойный провайдер» должен быть общеизвестным фактом, иначе каждый процесс
// набивает свою серию неудач заново.

import {
  SETTINGS,
  TARGET_LANGS,
  assertProviderContract,
  readJsonSetting,
  writeJsonSetting,
} from './provider.js'
import {
  DEFAULT_TRANSLATION_ROUTING,
  defaultTranslationRouting,
  normalizeTranslationRouting,
} from '../../shared/settings.js'
import { createDeepLProvider } from './providers/deepl.js'
import { createMyMemoryProvider } from './providers/mymemory.js'
import { createUsage } from './usage.js'

/**
 * Маршрут по умолчанию. Узбекский — единственный язык с фоллбэком, потому что
 * его поддержка у DeepL под вопросом (см. шапку providers/deepl.js).
 */
export const DEFAULT_ROUTING = DEFAULT_TRANSLATION_ROUTING

// Сколько подряд идущих сбоев подряд считаются «провайдер сломался».
// Два — это ещё случайность (обрыв, таймаут), три — уже система.
const FAILURE_THRESHOLD = 3

// Лестница кулдауна по числу серий. Ровно та же логика, что у блокировок
// входа: разовый сбой стоит минуту, устойчивый — час.
const COOLDOWN_STEPS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000])

// Неверный ключ повтором не лечится — ждём, пока его поправят в админке.
const AUTH_COOLDOWN_MS = 15 * 60_000

// Исчерпанная квота восстанавливается сама, но не скоро.
const QUOTA_COOLDOWN_MS = 60 * 60_000

// Потолок на паузу, которую попросил сам провайдер: Retry-After в сутки
// означал бы, что очередь встала до перезапуска.
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000

/**
 * @param {object} db соединение из server/db/index.js
 * @param {{providers?: object[], usage?: object}} [options]
 *   providers подменяются в тестах; по умолчанию собираются оба боевых.
 */
export const createRegistry = (db, options = {}) => {
  const providers = (options.providers ?? [
    createDeepLProvider({ db }),
    createMyMemoryProvider({ db }),
  ]).map(assertProviderContract)

  const usage = options.usage ?? createUsage(db)

  const byCode = new Map(providers.map((provider) => [provider.code, provider]))

  /**
   * Маршрутизация из настроек, приведённая к рабочему виду. Любая порча
   * (не массив, неизвестный код провайдера, лишний язык) молча заменяется
   * умолчанием для этого языка: переводы важнее строгости к содержимому
   * настройки, которую правят руками.
   */
  const routing = () => {
    const stored = readJsonSetting(db, SETTINGS.routing, null)
    if (stored == null) return defaultTranslationRouting()

    const normalized = normalizeTranslationRouting(stored)
    if (!normalized.ok) {
      console.warn(`[translate] routing invalid: key=${SETTINGS.routing}`)
      return defaultTranslationRouting()
    }
    return normalized.value
  }

  // --- кулдаун -------------------------------------------------------------

  const readCooldowns = () => {
    const stored = readJsonSetting(db, SETTINGS.cooldowns, null)
    return stored && typeof stored === 'object' ? stored : {}
  }

  const stateOf = (code, now = Date.now()) => {
    const entry = readCooldowns()[code]
    if (!entry || typeof entry !== 'object') return { strikes: 0, until: 0, kind: null }

    const until = Number(entry.until) || 0
    return {
      strikes: Number(entry.strikes) || 0,
      until: until > now ? until : 0,
      kind: typeof entry.kind === 'string' ? entry.kind : null,
    }
  }

  const isCoolingDown = (code, now = Date.now()) => stateOf(code, now).until > now

  /**
   * Сколько ждать после сбоя. Просьбу провайдера уважаем, но не безгранично;
   * для kind, которые повтором не лечатся, срок фиксированный.
   */
  const cooldownFor = (kind, strikes, retryAfterMs) => {
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
    }
    if (kind === 'auth') return AUTH_COOLDOWN_MS
    if (kind === 'quota') return QUOTA_COOLDOWN_MS
    if (strikes < FAILURE_THRESHOLD) return 0

    const level = strikes - FAILURE_THRESHOLD
    return COOLDOWN_STEPS_MS[Math.min(level, COOLDOWN_STEPS_MS.length - 1)]
  }

  /**
   * Учитывает сбой провайдера. Возвращает новое состояние кулдауна.
   * Транзакция нужна по той же причине, что и в usage.add: чтение JSON,
   * изменение и запись — три шага, а процессов несколько.
   */
  const noteFailure = (code, kind, options2 = {}) => {
    const { now = Date.now(), retryAfterMs = null } = options2

    return db.transaction(() => {
      const all = readCooldowns()
      const previous = all[code] && typeof all[code] === 'object' ? all[code] : {}
      const strikes = (Number(previous.strikes) || 0) + 1
      const pause = cooldownFor(kind, strikes, retryAfterMs)
      const entry = {
        strikes,
        kind,
        until: pause ? now + pause : Number(previous.until) || 0,
        at: now,
      }

      writeJsonSetting(db, SETTINGS.cooldowns, { ...all, [code]: entry }, now)
      return entry
    })
  }

  /** Успех обнуляет серию: провайдер снова считается здоровым. */
  const noteSuccess = (code, now = Date.now()) => {
    const all = readCooldowns()
    if (!all[code]) return

    db.transaction(() => {
      const current = readCooldowns()
      if (!current[code]) return
      delete current[code]
      writeJsonSetting(db, SETTINGS.cooldowns, current, now)
    })
  }

  // --- выбор ---------------------------------------------------------------

  /**
   * Первый пригодный провайдер для языка либо null.
   *
   * Асинхронный, потому что до проверки supports() нужно дать провайдеру
   * подтянуть список языков (prepare), а до отправки — свериться с квотой.
   * Оба шага кэшированы, поэтому в горячем цикле это чтение из SQLite,
   * а не запрос по сети.
   *
   * @param {string} lang
   * @param {{now?: number, chars?: number, signal?: AbortSignal}} [options2]
   * @returns {Promise<{provider: object, reason: null}|{provider: null, reason: string}>}
   */
  const pick = async (lang, options2 = {}) => {
    const { now = Date.now(), chars = 0, signal = null } = options2

    const chain = routing()[lang]
    if (!chain || !chain.length) return { provider: null, reason: 'no_route' }

    // Причина отказа последнего кандидата информативнее, чем общее «нет
    // провайдера»: она уезжает в translation_jobs.last_error и в админку.
    let reason = 'no_provider'

    for (const code of chain) {
      const provider = byCode.get(code)
      if (!provider) continue

      if (!provider.isConfigured()) {
        reason = 'not_configured'
        continue
      }
      if (isCoolingDown(code, now)) {
        reason = 'cooldown'
        continue
      }

      if (typeof provider.prepare === 'function') {
        await provider.prepare({ now, signal })
      }
      if (!provider.supports(lang, now)) {
        reason = 'unsupported_lang'
        continue
      }

      const quota = await usage.preflight(code, provider, { chars, now, signal })
      if (!quota.ok) {
        reason = 'quota_exhausted'
        continue
      }

      return { provider, reason: null }
    }

    return { provider: null, reason }
  }

  /** Состояние всех провайдеров для админки. */
  const list = (now = Date.now()) =>
    providers.map((provider) => {
      const state = stateOf(provider.code, now)
      return {
        code: provider.code,
        title: provider.title,
        configured: provider.isConfigured(),
        langs: TARGET_LANGS.filter((lang) => provider.supports(lang, now)),
        cooldownUntil: state.until || null,
        strikes: state.strikes,
        configFields: provider.configFields,
      }
    })

  return {
    providers,
    get: (code) => byCode.get(code) ?? null,
    routing,
    pick,
    list,
    noteFailure,
    noteSuccess,
    isCoolingDown,
    stateOf,
    usage,
  }
}
