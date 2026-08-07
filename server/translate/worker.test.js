import { beforeEach, describe, expect, it } from 'vitest'

import { createSqliteDriver } from '../db/driver.js'
import { runMigrations } from '../db/migrate.js'
import { createTranslateWorker, enqueueForKey, sourceHash } from './worker.js'

/**
 * Полная схема, а не один 001_init.sql: аренда и квота живут в колонках
 * и таблице из 009, и тест на копии старой схемы проверял бы не тот код.
 */
const createTestDb = () => {
  const db = createSqliteDriver(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

const putEntry = (db, locale, key, value, extra = {}) => {
  const at = Date.now()
  db.run(
    `INSERT INTO content_entries (locale, key, value, source, is_locked, source_hash,
                                  provider, translated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(locale, key) DO UPDATE SET value = excluded.value,
                                            source = excluded.source,
                                            is_locked = excluded.is_locked,
                                            source_hash = excluded.source_hash`,
    [
      locale,
      key,
      value,
      extra.source ?? 'manual',
      extra.isLocked ? 1 : 0,
      extra.sourceHash ?? sourceHash(value),
      at,
    ]
  )
}

/** Провайдер-пустышка: считает вызовы и возвращает предсказуемый перевод. */
const fakeProvider = (overrides = {}) => {
  const calls = []
  return {
    calls,
    provider: {
      code: 'fake',
      title: 'Fake',
      maxBatchTexts: overrides.maxBatchTexts ?? 50,
      maxBatchChars: overrides.maxBatchChars ?? 25_000,
      configFields: [],
      isConfigured: () => true,
      supports: () => true,
      toProviderLang: (lang) => lang,
      usage: async () => null,
      translate: async (texts, lang) => {
        calls.push({ texts: [...texts], lang })
        if (overrides.fail) throw overrides.fail
        return {
          texts: texts.map((text) => `[${lang}] ${text}`),
          billedChars: texts.join('').length,
        }
      },
    },
  }
}

/** Учёт-пустышка: квота без ограничений, удержания всегда выдаются. */
const openUsage = () => ({
  preflight: async () => ({ ok: true, used: 0, limit: null }),
  reserve: async () => ({ ok: true, token: `t${Math.random()}`, chars: 0 }),
  commit: () => true,
  release: () => true,
  releaseOwned: () => 0,
  add: () => {},
})

const makeWorker = (db, provider, options = {}) =>
  createTranslateWorker(db, {
    registry: {
      pick: async () => ({ provider, reason: null }),
      noteSuccess: () => {},
      noteFailure: () => {},
      usage: null,
    },
    usage: openUsage(),
    ...options,
  })

describe('enqueueForKey', () => {
  let db
  beforeEach(() => {
    db = createTestDb()
  })

  it('не ставит задачу, если перевод уже соответствует исходнику', () => {
    const ru = 'Наши преимущества'
    putEntry(db, 'ru', 'services.h2', ru)
    putEntry(db, 'en', 'services.h2', 'Our advantages', {
      source: 'machine',
      sourceHash: sourceHash(ru),
    })

    const result = enqueueForKey(db, 'services.h2', ru, { langs: ['en'] })

    expect(result.upToDate).toEqual(['en'])
    expect(result.queued).toEqual([])
    expect(db.get('SELECT COUNT(*) n FROM translation_jobs').n).toBe(0)
  })

  it('не перетирает ручную правку, а помечает её устаревшей', () => {
    putEntry(db, 'ru', 'hero.title', 'Новый заголовок')
    putEntry(db, 'en', 'hero.title', 'Отредактировано человеком', {
      isLocked: true,
      sourceHash: sourceHash('Старый заголовок'),
    })

    const result = enqueueForKey(db, 'hero.title', 'Новый заголовок', { langs: ['en'] })

    expect(result.stale).toEqual(['en'])
    expect(result.queued).toEqual([])
  })

  it('ставит задачу заново по флагу force даже для ручной правки', () => {
    putEntry(db, 'ru', 'hero.title', 'Заголовок')
    putEntry(db, 'en', 'hero.title', 'Ручной перевод', { isLocked: true })

    const result = enqueueForKey(db, 'hero.title', 'Заголовок', {
      langs: ['en'],
      force: true,
    })

    expect(result.queued).toEqual(['en'])
  })

  it('повторные постановки не размножают задачи', () => {
    putEntry(db, 'ru', 'form.btn', 'Отправить')
    for (let i = 0; i < 5; i += 1) {
      enqueueForKey(db, 'form.btn', `Отправить ${i}`, { langs: ['en'] })
    }
    expect(db.get('SELECT COUNT(*) n FROM translation_jobs').n).toBe(1)
    expect(db.get('SELECT source_text FROM translation_jobs').source_text).toBe('Отправить 4')
  })
})

describe('tick', () => {
  let db
  beforeEach(() => {
    db = createTestDb()
  })

  it('переводит и записывает результат', async () => {
    const ru = 'Наши проекты'
    putEntry(db, 'ru', 'projects.h2', ru)
    enqueueForKey(db, 'projects.h2', ru, { langs: ['en'] })

    const { provider, calls } = fakeProvider()
    const summary = await makeWorker(db, provider).tick()

    expect(summary.applied).toBe(1)
    expect(calls).toHaveLength(1)

    const row = db.get("SELECT value, source, provider FROM content_entries WHERE locale='en' AND key='projects.h2'")
    expect(row.value).toBe('[en] Наши проекты')
    expect(row.source).toBe('machine')
    expect(row.provider).toBe('fake')
  })

  it('отбрасывает результат, если русский успели изменить', async () => {
    const ru = 'Первая редакция'
    putEntry(db, 'ru', 'about.p1', ru)
    enqueueForKey(db, 'about.p1', ru, { langs: ['en'] })

    // Правка приходит после постановки задачи, но до обработки.
    putEntry(db, 'ru', 'about.p1', 'Вторая редакция')

    const { provider } = fakeProvider()
    const summary = await makeWorker(db, provider).tick()

    expect(summary.skipped).toBe(1)
    expect(summary.applied).toBe(0)
    expect(db.get("SELECT value FROM content_entries WHERE locale='en' AND key='about.p1'")).toBeUndefined()
  })

  it('режет пачку по лимиту провайдера', async () => {
    for (let i = 0; i < 5; i += 1) {
      const key = `k${i}`
      putEntry(db, 'ru', key, `Текст ${i}`)
      enqueueForKey(db, key, `Текст ${i}`, { langs: ['en'] })
    }

    const { provider, calls } = fakeProvider({ maxBatchTexts: 2 })
    await makeWorker(db, provider).tick()

    expect(calls.map((c) => c.texts.length)).toEqual([2, 2, 1])
  })

  it('защищает бренды от перевода', async () => {
    const ru = 'Официальные бренды: Shivaki и Mitsubishi Electric'
    putEntry(db, 'ru', 'services.equipment.desc', ru)
    enqueueForKey(db, 'services.equipment.desc', ru, { langs: ['en'] })

    const { provider, calls } = fakeProvider()
    await makeWorker(db, provider).tick()

    // В провайдер уходят плейсхолдеры, а не сами названия.
    expect(calls[0].texts[0]).not.toContain('Shivaki')
    expect(calls[0].texts[0]).not.toContain('Mitsubishi Electric')

    // В результате названия восстановлены.
    const value = db.get(
      "SELECT value FROM content_entries WHERE locale='en' AND key='services.equipment.desc'"
    ).value
    expect(value).toContain('Shivaki')
    expect(value).toContain('Mitsubishi Electric')
  })

  it('вторая аренда не берётся, пока первая жива', async () => {
    putEntry(db, 'ru', 'x', 'Текст')
    enqueueForKey(db, 'x', 'Текст', { langs: ['en'] })

    const { provider } = fakeProvider()
    const first = makeWorker(db, provider)
    const second = makeWorker(db, provider)

    // Аренду берёт первый и держит её до конца прохода.
    db.run(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('translate.lease', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ owner: first.owner, until: Date.now() + 60_000 }), Date.now()]
    )

    const summary = await second.tick()
    expect(summary.lease).toBe('busy')
    expect(summary.claimed).toBe(0)
  })
})
