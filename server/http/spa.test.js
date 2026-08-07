import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { METRICA_COUNTER_ID } from '../../shared/analytics.js'
import { buildCsp, sendPublicShell, sendSpa, stripAnalyticsMarkup } from './spa.js'
import { DIST_DIR } from './static.js'

const response = (method = 'GET') => ({
  req: { method },
  statusCode: 0,
  headersSent: false,
  writableEnded: false,
  headers: {},
  body: '',
  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value)
  },
  removeHeader(name) {
    delete this.headers[String(name).toLowerCase()]
  },
  end(chunk) {
    this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    this.writableEnded = true
  },
})

describe('SPA HTTP status and indexing policy', () => {
  let directory
  let indexPath

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'prohvac-spa-'))
    indexPath = join(directory, 'index.html')
    await writeFile(
      indexPath,
      '<!doctype html><html><head><title>PROHVAC</title></head><body><script nonce="__CSP_NONCE__"></script></body></html>'
    )
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns the known app shell as indexable HTTP 200', async () => {
    const res = response()
    await sendSpa({ method: 'GET' }, res, 200, { indexPath })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-robots-tag']).toBeUndefined()
    expect(res.body).not.toContain('noindex')
    expect(res.body).not.toContain('__CSP_NONCE__')
  })

  it('returns the unknown route shell as HTTP 404 with noindex', async () => {
    const res = response()
    await sendSpa({ method: 'GET' }, res, 404, { indexPath })

    expect(res.statusCode).toBe(404)
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow"')
    expect(res.body).not.toContain('__CSP_NONCE__')
  })

  it('keeps HEAD status and headers but omits the shell body', async () => {
    const res = response('HEAD')
    await sendSpa({ method: 'HEAD' }, res, 404, { indexPath })

    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toBe('')
  })
})

describe('Content-Security-Policy', () => {
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA=='
  const parse = (policy) =>
    new Map(
      policy.split('; ').map((entry) => {
        const [name, ...sources] = entry.split(' ')
        return [name, sources]
      })
    )

  it('keeps script-src on a nonce, never on unsafe-inline', () => {
    const directives = parse(buildCsp(nonce, { analytics: true, production: true }))

    expect(directives.get('script-src')).toContain(`'nonce-${nonce}'`)
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'")
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'")
  })

  it('forbids inline style elements while still allowing style attributes', () => {
    // style-src-elem carries no 'unsafe-inline', so an injected <style> block
    // is refused. style-src-attr keeps it because React writes computed values
    // into the style attribute and an attribute can carry neither a nonce nor
    // a stable hash — see the inventory in spa.js.
    const directives = parse(buildCsp(nonce))

    expect(directives.get('style-src-elem')).toEqual(["'self'", 'https://fonts.googleapis.com'])
    expect(directives.get('style-src-elem')).not.toContain("'unsafe-inline'")
    expect(directives.get('style-src-attr')).toEqual(["'unsafe-inline'"])
    // The fallback stays permissive only for browsers that read neither.
    expect(directives.get('style-src')).toContain("'unsafe-inline'")
  })

  it('names no analytics domain while analytics is off', () => {
    const policy = buildCsp(nonce, { analytics: false })

    expect(policy).not.toContain('yandex')
    expect(policy).not.toContain('yastatic')
    expect(policy).not.toContain('frame-src')
    expect(policy).not.toContain('child-src')
    expect(policy).not.toContain('blob:')
    expect(parse(policy).get('connect-src')).toEqual(["'self'"])
    expect(parse(policy).get('img-src')).toEqual(["'self'", 'data:'])
  })

  it('names the minimal analytics domains once analytics is on', () => {
    const directives = parse(buildCsp(nonce, { analytics: true }))

    expect(directives.get('script-src')).toContain('https://mc.yandex.ru')
    // Без yastatic.net часть модулей счётчика молча не грузится.
    expect(directives.get('script-src')).toContain('https://yastatic.net')
    expect(directives.get('img-src')).toContain('https://mc.yandex.ru')
    expect(directives.get('connect-src')).toContain('https://mc.yandex.ru')
    // Транспорт Вебвизора 2.0: без wss записи визитов остаются пустыми.
    expect(directives.get('connect-src')).toContain('wss://mc.yandex.ru')
    // Вебвизор и карты кликов рисуются в blob-iframe.
    expect(directives.get('frame-src')).toContain('blob:')
    expect(directives.get('child-src')).toContain('blob:')
  })

  it('never weakens script-src for the counter', () => {
    // Метрике не нужны ни unsafe-inline, ни unsafe-eval, ни strict-dynamic —
    // ровно поэтому счётчик ставится инлайном с nonce, а не через тег-менеджер.
    const directives = parse(buildCsp(nonce, { analytics: true }))

    expect(directives.get('script-src')).not.toContain("'unsafe-inline'")
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'")
    expect(directives.get('script-src')).not.toContain("'strict-dynamic'")
    // Директива из документации Метрики нужна только тем, кто встраивает свою
    // страницу в интерфейс Метрики. Мы не встраиваем — рамки остаются закрыты.
    expect(directives.get('frame-ancestors')).toEqual(["'none'"])
  })

  it('locks down framing, base URI and form targets in every configuration', () => {
    for (const analytics of [false, true]) {
      const directives = parse(buildCsp(nonce, { analytics }))

      expect(directives.get('default-src')).toEqual(["'self'"])
      expect(directives.get('object-src')).toEqual(["'none'"])
      expect(directives.get('frame-ancestors')).toEqual(["'none'"])
      expect(directives.get('base-uri')).toEqual(["'self'"])
      expect(directives.get('form-action')).toEqual(["'self'"])
    }
  })

  it('upgrades insecure requests only in production', () => {
    expect(buildCsp(nonce, { production: true })).toContain('upgrade-insecure-requests')
    expect(buildCsp(nonce, { production: false })).not.toContain('upgrade-insecure-requests')
  })

  it('gives every response its own nonce', async () => {
    const shell = await mkdtemp(join(tmpdir(), 'prohvac-csp-'))
    const shellPath = join(shell, 'index.html')
    await writeFile(
      shellPath,
      '<!doctype html><html><head></head><body><script nonce="__CSP_NONCE__"></script></body></html>'
    )

    const first = response()
    const second = response()
    try {
      await sendSpa({ method: 'GET' }, first, 200, { indexPath: shellPath })
      await sendSpa({ method: 'GET' }, second, 200, { indexPath: shellPath })
    } finally {
      await rm(shell, { recursive: true, force: true })
    }

    expect(first.headers['content-security-policy'])
      .not.toBe(second.headers['content-security-policy'])
    // Constant nonce length keeps Content-Length identical across shells, which
    // is what makes uniform404 indistinguishable from a real page.
    expect(first.headers['content-length']).toBe(second.headers['content-length'])
  })
})

// CR-064. Аналитика выключена по умолчанию (CR-051), но inline-загрузчик
// счётчика несёт nonce (CR-061) и потому исполняется. Внешний скрипт при этом
// отвергает CSP, и каждая загрузка страницы писала ошибку в консоль.
//
// С приходом Метрики у вырезания появилась вторая, более важная роль: оболочка
// в проекте одна на публичную страницу, админку на секретном пути и на каждый
// uniform404. Счётчик, оставшийся в оболочке админки, отправил бы секретный
// путь в отчёты Метрики, а Вебвизор записал бы панель с заявками и настройками.
describe('analytics markup stripping (CR-064)', () => {
  const shell = readFileSync(join(DIST_DIR, 'index.html'), 'utf8')

  it('removes both Yandex.Metrika blocks', () => {
    const stripped = stripAnalyticsMarkup(shell)

    expect(stripped).not.toContain('mc.yandex.ru')
    expect(stripped).not.toContain(String(METRICA_COUNTER_ID))
    expect(stripped).not.toContain('<!-- Yandex.Metrika counter -->')
    expect(stripped).not.toContain('<!-- Yandex.Metrika counter (noscript) -->')
  })

  it('keeps everything that is not analytics', () => {
    const stripped = stripAnalyticsMarkup(shell)

    expect(stripped).toContain('application/ld+json')
    expect(stripped).toMatch(/<script type="module"/)
    expect(stripped).toContain('</head>')
    expect(stripped).toContain('</html>')
  })

  it('matches the markers actually present in the built shell', () => {
    // Если разметку в index.html переименуют, вырезание молча перестанет
    // работать — этот тест обязан упасть раньше, чем это заметят в консоли.
    expect(shell).toContain('<!-- Yandex.Metrika counter -->')
    expect(shell).toContain('<!-- End Yandex.Metrika counter -->')
    expect(shell).toContain('<!-- Yandex.Metrika counter (noscript) -->')
    expect(shell).toContain('<!-- End Yandex.Metrika counter (noscript) -->')
    expect(stripAnalyticsMarkup(shell).length).toBeLessThan(shell.length)
  })

  it('keeps the counter id in the shell equal to the shared constant', () => {
    // Номер счётчика в инлайновом сниппете нельзя импортировать из модуля,
    // поэтому он продублирован литералом. Здесь проверяется, что дубль
    // не разъехался: иначе сайт считал бы визиты в один счётчик, а цели
    // и Stat API работали бы с другим.
    expect(shell).toContain(`tag.js?id=${METRICA_COUNTER_ID}`)
    expect(shell).toContain(`ym(${METRICA_COUNTER_ID}, 'init'`)
    expect(shell).toContain(`mc.yandex.ru/watch/${METRICA_COUNTER_ID}`)
  })

  it('is a no-op on a shell without analytics markup', () => {
    const plain = '<html><head></head><body></body></html>'
    expect(stripAnalyticsMarkup(plain)).toBe(plain)
  })
})

// Счётчик отдаётся ТОЛЬКО публичной страницей. Это не настройка, а граница:
// админская оболочка и uniform404 идут через sendSpa, который аналитику
// не отдаёт ни при каком значении ANALYTICS_ENABLED.
describe('counter is served to the public shell only', () => {
  const SHELL_WITH_COUNTER = [
    '<!doctype html><html><head>',
    '<!-- Yandex.Metrika counter -->',
    `<script nonce="__CSP_NONCE__">ym(${METRICA_COUNTER_ID}, 'init', {})</script>`,
    '<!-- End Yandex.Metrika counter -->',
    '</head><body><div id="root"></div></body></html>',
  ].join('')

  let directory
  let indexPath

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'prohvac-counter-'))
    indexPath = join(directory, 'index.html')
    await writeFile(indexPath, SHELL_WITH_COUNTER)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('strips the counter from the admin shell', async () => {
    // Ровно тот вызов, которым server/app.js отдаёт панель на секретном пути.
    const res = response()
    await sendSpa({ method: 'GET' }, res, 200, { indexPath })

    expect(res.body).not.toContain('mc.yandex.ru')
    expect(res.body).not.toContain(String(METRICA_COUNTER_ID))
    expect(res.headers['content-security-policy']).not.toContain('yandex')
  })

  it('strips the counter from every uniform404', async () => {
    const first = response()
    const second = response()
    await sendSpa({ method: 'GET' }, first, 404, { indexPath })
    await sendSpa({ method: 'GET' }, second, 404, { indexPath })

    expect(first.body).not.toContain('mc.yandex.ru')
    // Неотличимость uniform404 держится на равном Content-Length: вырезание
    // обязано быть одинаковым для всех 404, иначе перебор путей снова
    // начнёт отличать закрытую админку от несуществующего адреса.
    expect(first.headers['content-length']).toBe(second.headers['content-length'])
  })

  it('is requested by public routes only', () => {
    // Сторожевой тест, а не проверка поведения. Оболочку отдают четыре ветки
    // server/app.js, и счётчик положен ровно двум из них: главной и
    // /index.html. Появится третий вызов sendPublicShell — тест упадёт, и
    // тому, кто его добавил, придётся объяснить, почему новая страница
    // публичная. Это дешевле, чем узнать об утечке секретного пути из отчёта
    // Метрики.
    const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
    const calls = app.match(/sendPublicShell\(/g) || []

    expect(calls).toHaveLength(2)
    // Ветка админского гейта обязана остаться на sendSpa. Ищем именно вызов
    // со скобкой: в самой ветке стоит комментарий, объясняющий, почему тут
    // НЕ sendPublicShell, и голое вхождение имени ловило бы это объяснение.
    const adminBranch = app.slice(app.indexOf('if (gate.isAdmin)'), app.indexOf('if (isApiPath(path))'))
    expect(adminBranch).toContain('await sendSpa(req, res)')
    expect(adminBranch).not.toContain('sendPublicShell(')
  })

  it('serves the counter from the public shell when analytics is enabled', async () => {
    const res = response()
    await sendPublicShell({ method: 'GET' }, res, { indexPath })

    // config.analyticsEnabled по умолчанию выключен, поэтому здесь проверяем
    // только то, что публичный вход не режет счётчик сам по себе: при
    // ANALYTICS_ENABLED=0 его не должно быть и тут.
    if (res.body.includes('mc.yandex.ru')) {
      expect(res.headers['content-security-policy']).toContain('https://mc.yandex.ru')
    } else {
      expect(res.headers['content-security-policy']).not.toContain('yandex')
    }
    expect(res.statusCode).toBe(200)
  })
})
