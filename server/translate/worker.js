// Очередь автоперевода: постановка задач и их обработка.
//
// ПОЧЕМУ АРЕНДА, А НЕ ФЛАГ В ПАМЯТИ. Passenger держит пул процессов. Флаг
// «я уже работаю» в переменной модуля виден только своему процессу, поэтому
// два воркера взяли бы одну пачку, отправили её дважды и сожгли двойной
// расход квоты. Аренда лежит в app_state и перехватывается по истечении срока,
// иначе упавший процесс заклинил бы очередь навсегда.
//
// ПОЧЕМУ АРЕНДУ НАДО ПРОДЛЕВАТЬ (CR-039). Срок брался один раз на весь проход.
// Проход длиннее срока — один медленный провайдер, одна большая очередь —
// означал, что аренда истекала, пока первый воркер стоял на await: второй
// забирал те же задачи и отправлял их ещё раз. Теперь у аренды есть случайный
// токен, продление условно (только владелец токена), а потеря аренды
// прекращает обработку и отменяет запрос к провайдеру через AbortSignal.
// Право дописать результат даёт не аренда, а claim_token самой задачи:
// перехваченную строку старый воркер не тронет, даже если ответ провайдера
// пришёл к нему уже после takeover.
//
// ПОЧЕМУ ПРОВЕРКА source_hash ПОСЛЕ ОТВЕТА. Пока пачка была в полёте, редактор
// мог переписать русский текст. Записать пришедший перевод означало бы
// подставить перевод предыдущей редакции под новый исходник — незаметно
// и надолго. Поэтому результат применяется только если исходник не изменился.

import { createHash } from 'node:crypto'

import { createRegistry } from './registry.js'
import { createUsage } from './usage.js'
import { claimJobs, createLease, extendClaims, recoverExpiredClaims } from './lease.js'
import { protectTerms, restoreTerms, termsFromSetting } from './protect.js'
import { ProviderError, SETTINGS, TARGET_LANGS, isTargetLang, readJsonSetting } from './provider.js'

const LEASE_MS = 2 * 60_000

// Пауза перед повтором. 429 сюда не попадает: провайдер сам говорит, сколько
// ждать, и его просьбу уважает registry.noteFailure.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]
const MAX_ATTEMPTS = 5

// Ошибки, при которых провайдер точно ничего не посчитал: запрос отвергнут
// до обработки. Всё остальное (сеть, таймаут, 5xx) могло дойти и списаться,
// поэтому удержание квоты по ним подтверждается, а не освобождается —
// в спорном случае лучше недосчитать себе символов, чем провайдеру.
const UNBILLED_KINDS = new Set(['auth', 'quota', 'rate_limit', 'bad_request', 'unsupported_lang'])

export const sourceHash = (value) =>
  createHash('sha256').update(String(value ?? '').normalize('NFC').trim(), 'utf8').digest('hex')

const now = () => Date.now()

// ---------------------------------------------------------------------------
// Постановка задач
// ---------------------------------------------------------------------------

/**
 * Ставит перевод ключа на все целевые языки, кроме тех, где он не нужен.
 *
 * Возвращает разбор по языкам, потому что редактору важно видеть разницу:
 * «поставлено в очередь» и «оставлено как есть, потому что правили руками» —
 * это разные исходы, и молчание о втором выглядело бы как потеря правки.
 */
export const enqueueForKey = (db, key, russianValue, options = {}) => {
  const { force = false, langs = TARGET_LANGS } = options
  const hash = sourceHash(russianValue)
  const at = now()

  const queued = []
  const stale = []
  const upToDate = []

  for (const lang of langs) {
    if (!isTargetLang(lang)) continue

    const row = db.get(
      'SELECT value, source, is_locked, source_hash FROM content_entries WHERE locale = ? AND key = ?',
      [lang, key]
    )

    const hasValue = Boolean(row?.value)
    if (!force && hasValue && row.source_hash === hash) {
      upToDate.push(lang)
      continue
    }

    // Ручную правку не перетираем: она пометится устаревшей, и решение
    // остаётся за редактором. Тихая перезапись человеческой работы машинным
    // переводом необратима, а устаревший текст виден в интерфейсе.
    if (!force && hasValue && row.is_locked) {
      stale.push(lang)
      continue
    }

    // Частичный уникальный индекс по (key, lang) для активных статусов делает
    // это естественной дедупликацией: пять сохранений подряд оставят
    // одну задачу с последним текстом, а не пять.
    db.run(
      `INSERT INTO translation_jobs (key, lang, source_text, source_hash, status, run_after,
                                     attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, 0, NULL, ?, ?)
       ON CONFLICT (key, lang) WHERE status IN ('queued', 'running', 'deferred')
       DO UPDATE SET source_text = excluded.source_text,
                     source_hash = excluded.source_hash,
                     status = 'queued',
                     run_after = excluded.run_after,
                     attempts = 0,
                     last_error = NULL,
                     claim_owner = NULL,
                     claim_token = NULL,
                     claim_until = 0,
                     updated_at = excluded.updated_at`,
      [key, lang, String(russianValue ?? ''), hash, at, at, at]
    )
    queued.push(lang)
  }

  return { queued, stale, upToDate }
}

// ---------------------------------------------------------------------------
// Обработка
// ---------------------------------------------------------------------------

/**
 * Закрывает задачу. Условие по claim_token обязательно: пока пачка была
 * в полёте, задачу мог перехватить другой воркер (аренда истекла, claim
 * реклеймлен) либо enqueueForKey мог вернуть ЭТУ ЖЕ строку в 'queued' с новым
 * текстом. И то и другое означает, что строка больше не наша, и запись
 * результата закрыла бы чужую работу нашим ответом.
 *
 * @returns {boolean} состоялся ли переход
 */
const finishJob = (db, job, status, extra = {}) => {
  const info = db.run(
    `UPDATE translation_jobs
        SET status = ?, provider = COALESCE(?, provider), last_error = ?,
            attempts = ?, run_after = ?,
            claim_owner = NULL, claim_token = NULL, claim_until = 0,
            updated_at = ?
      WHERE id = ? AND status = 'running' AND claim_token = ?`,
    [
      status,
      extra.provider ?? null,
      extra.error ?? null,
      extra.attempts ?? 0,
      extra.runAfter ?? 0,
      now(),
      job.id,
      job.claim_token,
    ]
  )
  return (info.changes ?? 0) > 0
}

/** Текущий русский исходник — источник истины при применении результата. */
const currentRussianHash = (db, key) => {
  const row = db.get(
    "SELECT value FROM content_entries WHERE locale = 'ru' AND key = ?",
    [key]
  )
  return row ? sourceHash(row.value) : null
}

/**
 * Применяет перевод и закрывает задачу одной транзакцией.
 *
 * Раздельные шаги давали окно, в котором перевод уже записан, а задача ещё
 * 'running': перехватчик успевал вернуть её в очередь, и тот же текст
 * переводился второй раз за деньги.
 *
 * @returns {'applied'|'skipped'|'lost'} 'lost' — строка больше не наша
 */
const completeJob = (db, job, text, providerCode) =>
  db.transaction(() => {
    const row = db.get('SELECT status, claim_token FROM translation_jobs WHERE id = ?', [job.id])
    if (!row || row.status !== 'running' || row.claim_token !== job.claim_token) return 'lost'

    // Между отправкой и ответом русский мог измениться. Тогда результат
    // устарел, и его место уже занимает новая задача.
    const changed = currentRussianHash(db, job.key) !== job.source_hash
    const locked = db.get(
      'SELECT is_locked FROM content_entries WHERE locale = ? AND key = ?',
      [job.lang, job.key]
    )?.is_locked

    if (changed || locked) {
      finishJob(db, job, 'skipped', { provider: providerCode, error: changed ? 'source_changed' : 'locked' })
      return 'skipped'
    }

    // Сначала закрытие задачи, потом запись текста: обратный порядок оставлял
    // бы записанный перевод при незакрытой задаче, если условие по claim_token
    // всё-таки не выполнилось.
    if (!finishJob(db, job, 'done', { provider: providerCode })) return 'lost'

    const at = now()
    db.run(
      `INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash,
                                    provider, translated_at, updated_at)
       VALUES (?, ?, ?, 'machine', 0, ?, ?, ?, ?)
       ON CONFLICT(locale, key) DO UPDATE SET value = excluded.value,
                                              source = 'machine',
                                              source_hash = excluded.source_hash,
                                              provider = excluded.provider,
                                              translated_at = excluded.translated_at,
                                              updated_at = excluded.updated_at`,
      [job.lang, job.key, text, job.source_hash, providerCode, at, at]
    )

    // Поколение контента растёт: по нему инвалидируется кэш отдачи локалей
    // в других процессах пула — событий между ними нет.
    db.run(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('content_generation', '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
                                      updated_at = excluded.updated_at`,
      [at]
    )

    return 'applied'
  })

/** Режет группу задач на пачки по ограничениям провайдера. */
const toBatches = (jobs, provider) => {
  const maxTexts = Math.max(1, provider.maxBatchTexts || 1)
  const maxChars = Math.max(1, provider.maxBatchChars || Infinity)

  const batches = []
  let current = []
  let chars = 0

  for (const job of jobs) {
    const size = job.source_text.length
    const full = current.length >= maxTexts || (current.length && chars + size > maxChars)
    if (full) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(job)
    chars += size
  }
  if (current.length) batches.push(current)
  return batches
}

const emptySummary = () => ({
  claimed: 0,
  applied: 0,
  translated: 0,
  skipped: 0,
  failed: 0,
  deferred: 0,
  recovered: 0,
  lost: 0,
})

export const createTranslateWorker = (db, options = {}) => {
  const registry = options.registry ?? createRegistry(db)
  const usage = options.usage ?? registry.usage ?? createUsage(db)
  const owner = options.owner ?? `${process.pid}-${Math.trunc(Math.random() * 1e6)}`
  const batchLimit = options.batchLimit ?? 200
  const leaseMs = options.leaseMs ?? LEASE_MS
  // Продление вчетверо чаще срока: одна пропущенная попытка (занятая база,
  // долгий GC) не должна стоить аренды, иначе лечение оказывается хуже болезни.
  const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.trunc(leaseMs / 4))
  const clock = options.now ?? (() => Date.now())
  const warn = options.warn ?? ((message) => console.warn(message))

  const lease = createLease(db, { ttlMs: leaseMs })

  // Состояние текущего прохода. Нужно снаружи ради остановки: stop() обязан
  // отменить запрос к провайдеру и отпустить аренду, не дожидаясь таймера.
  let stopping = false
  let inFlight = null
  let activeToken = null
  let activeAbort = null

  const terms = () => termsFromSetting(readJsonSetting(db, SETTINGS.protectedTerms, null))

  /**
   * Один проход по очереди под уже взятой арендой.
   * Вынесен из tick() ради читаемости: tick() отвечает за аренду и остановку.
   */
  const runUnderLease = async (token, controller, summary) => {
    const state = { held: true, renewedAt: clock() }

    /**
     * Продлевает аренду, если пришёл срок, и подтверждает, что она наша.
     * Возвращает false ровно один раз — дальше проход обязан свернуться.
     */
    const holdLease = (at = clock()) => {
      if (!state.held) return false

      if (stopping) {
        state.held = false
        controller.abort(new Error('translate: остановка воркера'))
        return false
      }

      if (at - state.renewedAt < heartbeatMs) return true

      let renewed = false
      try {
        renewed = lease.renew(token, at)
        // Срок задач продлевается вместе с арендой: иначе долгий, но живой
        // проход выглядел бы для recover() как брошенная работа.
        if (renewed) extendClaims(db, { owner, until: at + leaseMs, at })
      } catch (error) {
        // Сбой продления неотличим от потери аренды: продолжать работу,
        // не сумев подтвердить владение, значит рисковать двойной отправкой.
        // Вызов приходит и из таймера, поэтому исключение обязано остаться
        // здесь — наружу оно ушло бы как uncaughtException.
        warn(`[translate] аренда не продлена: ${error.message}`)
        renewed = false
      }

      if (!renewed) {
        state.held = false
        controller.abort(new Error('translate: аренда очереди потеряна'))
        return false
      }

      state.renewedAt = at
      return true
    }

    const heartbeat = heartbeatMs > 0 ? setInterval(() => holdLease(), heartbeatMs) : null
    heartbeat?.unref?.()

    try {
      summary.recovered = recoverExpiredClaims(db, { at: clock(), staleMs: leaseMs * 2 })

      const jobs = claimJobs(db, { limit: batchLimit, owner, claimMs: leaseMs, at: clock() })
      summary.claimed = jobs.length
      if (!jobs.length) return summary

      const byLang = new Map()
      for (const job of jobs) {
        if (!byLang.has(job.lang)) byLang.set(job.lang, [])
        byLang.get(job.lang).push(job)
      }

      for (const [lang, group] of byLang) {
        if (!holdLease()) break

        const chars = group.reduce((sum, job) => sum + job.source_text.length, 0)
        const picked = await registry.pick(lang, { chars, signal: controller.signal })

        if (!picked.provider) {
          // Провайдера нет — задачи ждут: настройку могут поправить в админке,
          // и терять текст из-за отсутствия ключа незачем.
          for (const job of group) {
            const moved = finishJob(db, job, 'deferred', {
              error: picked.reason,
              attempts: job.attempts,
              runAfter: clock() + BACKOFF_MS[0],
            })
            if (moved) summary.deferred += 1
            else summary.lost += 1
          }
          continue
        }

        let lost = false
        for (const batch of toBatches(group, picked.provider)) {
          if (!holdLease()) {
            lost = true
            break
          }

          try {
            const result = await runBatch(picked.provider, batch, controller.signal, holdLease)
            summary.applied += result.applied
            summary.skipped += result.skipped
            summary.lost += result.lost
            registry.noteSuccess(picked.provider.code)
          } catch (error) {
            // Сигнатура (code, kind, options): раньше сюда уходил объект
            // ошибки вместо строки, поэтому фиксированные кулдауны для
            // 'auth' и 'quota' не срабатывали ни разу, а Retry-After
            // от провайдера игнорировался.
            registry.noteFailure(picked.provider.code, error?.kind ?? 'transient', {
              retryAfterMs: error?.retryAfterMs ?? null,
            })
            const counts = failBatch(batch, error)
            summary.failed += counts.failed
            summary.deferred += counts.deferred
            summary.lost += counts.lost
          }
        }
        if (lost) break
      }

      return summary
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (!state.held) summary.lease = 'lost'
    }
  }

  /**
   * Отправляет пачку и раскладывает результат по задачам.
   *
   * Удержание квоты берётся ДО отправки и подтверждается фактическим счётом
   * провайдера: между проверкой остатка и прибавкой расхода стоял await,
   * и на нём соседний процесс успевал пройти ту же проверку.
   */
  const runBatch = async (provider, batch, signal, holdLease) => {
    const protectedTexts = batch.map((job) => protectTerms(job.source_text, terms()))
    const chars = protectedTexts.reduce((sum, item) => sum + item.text.length, 0)

    const reservation = await usage.reserve(provider.code, provider, {
      chars,
      owner,
      ttlMs: leaseMs,
      signal,
    })
    if (!reservation.ok) {
      throw new ProviderError('quota', `квота ${provider.code} исчерпана`, { provider: provider.code })
    }

    let sent = false
    let result = null
    try {
      // Последняя проверка перед тратой денег: если аренда потеряна, пачку
      // уже забрал другой воркер, и вторая отправка — это двойной счёт.
      if (!holdLease()) {
        throw new ProviderError('transient', 'аренда очереди потеряна', { provider: provider.code })
      }

      sent = true
      result = await provider.translate(
        protectedTexts.map((item) => item.text),
        provider.toProviderLang(batch[0].lang),
        { signal }
      )
    } catch (error) {
      const unbilled = !sent || UNBILLED_KINDS.has(error?.kind)
      if (unbilled) usage.release(reservation.token, sent ? 'provider_rejected' : 'pre_send_failure')
      else usage.commit(reservation.token, chars)
      throw error
    }

    // Сопоставление по индексу законно только при совпадении длины. Иначе
    // переводы разъедутся по ключам, и это самая незаметная из возможных
    // ошибок: тексты есть, они осмысленные, но стоят не на своих местах.
    if (!Array.isArray(result?.texts) || result.texts.length !== batch.length) {
      usage.commit(reservation.token, result?.billedChars ?? chars)
      throw new ProviderError('transient', `${provider.code}: ответ не совпал по длине пачки`, {
        provider: provider.code,
      })
    }

    usage.commit(reservation.token, result.billedChars ?? chars)

    // Результат уже оплачен, поэтому он применяется даже при потерянной
    // аренде: право на запись даёт claim_token задачи, и перехваченная
    // строка отвергнет её сама.
    let applied = 0
    let skipped = 0
    let lost = 0
    batch.forEach((job, index) => {
      const text = restoreTerms(result.texts[index], protectedTexts[index].map)
      const outcome = completeJob(db, job, text, provider.code)
      if (outcome === 'applied') applied += 1
      else if (outcome === 'skipped') skipped += 1
      else lost += 1
    })

    return { applied, skipped, lost }
  }

  /** Разносит ошибку пачки по задачам. Возвращает фактические переходы. */
  const failBatch = (batch, error) => {
    const kind = error instanceof ProviderError ? error.kind : 'transient'
    const retryable = kind !== 'auth' && kind !== 'bad_request' && kind !== 'unsupported_lang'
    const counts = { failed: 0, deferred: 0, lost: 0 }

    for (const job of batch) {
      // 429 — не вина контента, поэтому счётчик попыток не растёт: иначе
      // временная перегрузка провайдера исчерпала бы лимит попыток задачи.
      const attempts = kind === 'rate_limit' ? job.attempts : job.attempts + 1
      const exhausted = retryable && attempts >= MAX_ATTEMPTS

      if (!retryable || exhausted) {
        const moved = finishJob(db, job, 'failed', {
          error: `${kind}: ${error.message}`.slice(0, 300),
          attempts,
        })
        if (moved) counts.failed += 1
        else counts.lost += 1
        continue
      }

      const delay = error.retryAfterMs ?? BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
      const moved = finishJob(db, job, 'deferred', {
        error: `${kind}: ${error.message}`.slice(0, 300),
        attempts,
        runAfter: clock() + delay,
      })
      if (moved) counts.deferred += 1
      else counts.lost += 1
    }

    return counts
  }

  /** Один проход по очереди. Возвращает сводку, ничего не бросает. */
  const tick = async (options2 = {}) => {
    const { signal = null } = options2
    const summary = emptySummary()

    if (stopping) return { ...summary, lease: 'stopped' }

    const token = lease.acquire(owner, clock())
    if (!token) return { ...summary, lease: 'busy' }

    const controller = new AbortController()
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }

    activeToken = token
    activeAbort = controller

    const run = (async () => {
      try {
        await runUnderLease(token, controller, summary)
        summary.translated = summary.applied
        return summary
      } finally {
        lease.release(token, clock())
        if (activeToken === token) {
          activeToken = null
          activeAbort = null
        }
        inFlight = null
      }
    })()

    inFlight = run
    return run
  }

  const status = () => {
    const counts = db.all(
      'SELECT status, COUNT(*) AS n FROM translation_jobs GROUP BY status'
    )
    const map = Object.fromEntries(counts.map((row) => [row.status, row.n]))
    return {
      queued: map.queued ?? 0,
      running: map.running ?? 0,
      deferred: map.deferred ?? 0,
      failed: map.failed ?? 0,
      done: map.done ?? 0,
      skipped: map.skipped ?? 0,
    }
  }

  /**
   * Возвращает в очередь задачи с истёкшим claim. Срок владения, а не
   * updated_at: эта колонка меняется при любой записи в строку и ничего
   * не говорит о том, жив ли владелец.
   */
  const recover = (staleMs = leaseMs * 2) =>
    recoverExpiredClaims(db, { at: clock(), staleMs })

  /**
   * Отпускает аренду и удержания квоты. Вызывается из остановки процесса;
   * безопасна повторно — обе операции условны по владельцу.
   */
  const release = () => {
    const at = clock()
    const released = activeToken ? lease.release(activeToken, at) : false
    const holds = usage.releaseOwned ? usage.releaseOwned(owner, 'shutdown', at) : 0
    return { lease: released, reservations: holds }
  }

  /**
   * Останавливает воркер: отменяет запрос к провайдеру, ждёт завершения
   * текущего прохода не дольше timeoutMs и отпускает аренду.
   *
   * Ожидание ограничено намеренно: провайдер может не ответить вовсе, а
   * остановка процесса не должна зависеть от его доброй воли. Незавершённые
   * задачи останутся с истекающим claim и будут подобраны следующим воркером.
   */
  const stop = async (options2 = {}) => {
    const { timeoutMs = 5_000 } = options2
    stopping = true
    activeAbort?.abort(new Error('translate: остановка воркера'))

    if (inFlight) {
      let timer = null
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
      try {
        await Promise.race([inFlight.catch(() => {}), deadline])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    return release()
  }

  return {
    tick,
    status,
    recover,
    release,
    stop,
    enqueueForKey: (...args) => enqueueForKey(db, ...args),
    owner,
  }
}
