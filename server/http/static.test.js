// Containment tests for the static file server.
//
// Every case here asks the same question from a different angle: can a request
// make serveStatic hand back a byte that lives outside the root it was given?
// The assertions therefore check the response body for the planted secret
// rather than only the status code — a 200 with the wrong file and a 404 with
// the right one fail in opposite, equally important ways.

import { promises as fsp } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { serveStatic } from './static.js'

const SECRET = 'TOP-SECRET-OUTSIDE-ROOT'

const createResponse = (method = 'GET') => {
  const chunks = []
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  res.req = { method }
  res.statusCode = 200
  res.recorded = {}
  res.headersSent = false
  res.setHeader = (name, value) => {
    res.recorded[String(name).toLowerCase()] = String(value)
  }
  res.getHeader = (name) => res.recorded[String(name).toLowerCase()]
  res.removeHeader = (name) => {
    delete res.recorded[String(name).toLowerCase()]
  }
  res.text = () => Buffer.concat(chunks).toString('utf8')
  return res
}

const settled = async (res) => {
  if (res.writableEnded || res.destroyed) return
  await new Promise((resolve) => {
    res.on('finish', resolve)
    res.on('close', resolve)
    res.on('error', resolve)
  })
}

const request = async (urlPath, options = {}, method = 'GET', headers = {}) => {
  const res = createResponse(method)
  const served = await serveStatic({ method, url: urlPath, headers }, res, options)
  // A miss leaves the response untouched for the caller to finish, so there is
  // nothing to wait for; waiting anyway would hang until the test times out.
  if (served) await settled(res)
  return { served, res, body: res.text() }
}

// Windows refuses file symlinks without elevation or Developer Mode, so those
// cases are gated rather than faked: a silently passing test would claim
// coverage the run never had. Directory links survive as junctions, which
// lstat reports as symbolic links and realpath resolves through — the same two
// operations the production code relies on.
let fileLinksAvailable = false

/** Directory link, falling back to a junction where symlinks are refused. */
const linkDirectory = async (target, path) => {
  try {
    await symlink(target, path, 'dir')
  } catch {
    await symlink(target, path, 'junction')
  }
}

let outside
let root

describe('static file containment', () => {
  beforeAll(async () => {
    const probe = await mkdtemp(join(tmpdir(), 'prohvac-symlink-probe-'))
    try {
      await writeFile(join(probe, 'target'), 'x')
      await symlink(join(probe, 'target'), join(probe, 'link'))
      fileLinksAvailable = true
    } catch {
      fileLinksAvailable = false
    } finally {
      await rm(probe, { recursive: true, force: true })
    }
  })

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'prohvac-static-outside-'))
    root = await mkdtemp(join(tmpdir(), 'prohvac-static-root-'))
    await writeFile(join(outside, 'secret.txt'), SECRET)
    await writeFile(join(root, 'app.js'), 'export const ok = true\n')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'main.css'), 'body{color:red}')
  })

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it('serves a regular file inside the root', async () => {
    const { served, res, body } = await request('/app.js', { root })

    expect(served).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(body).toBe('export const ok = true\n')
    expect(res.getHeader('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(res.getHeader('Content-Length')).toBe(String(body.length))
  })

  it('answers HEAD with the headers of GET and no body', async () => {
    const { served, res, body } = await request('/app.js', { root }, 'HEAD')

    expect(served).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.getHeader('Content-Length')).toBe('23')
    expect(body).toBe('')
  })

  it('revalidates with ETag instead of resending the body', async () => {
    const first = await request('/app.js', { root })
    const etag = first.res.getHeader('ETag')
    expect(etag).toBeTruthy()

    const second = await request('/app.js', { root }, 'GET', { 'if-none-match': etag })

    expect(second.res.statusCode).toBe(304)
    expect(second.body).toBe('')
  })

  it.each([
    ['../ traversal', '/../secret.txt'],
    ['nested ../ traversal', '/assets/../../secret.txt'],
    ['percent-encoded traversal', '/%2e%2e/secret.txt'],
    ['uppercase percent-encoded traversal', '/%2E%2E/secret.txt'],
    ['backslash traversal', '/..\\secret.txt'],
    ['NUL truncation', '/app.js%00.png'],
  ])('never reads outside the root through %s', async (_name, urlPath) => {
    const { res, body } = await request(urlPath, { root })

    expect(body).not.toContain(SECRET)
    expect(res.statusCode).not.toBe(200)
  })

  it('does not decode twice, so double-encoded traversal stays a missing name', async () => {
    // '%252e%252e' decodes once to '%2e%2e', which is a literal file name and
    // must never be decoded a second time into '..'.
    const { served, body } = await request('/%252e%252e/secret.txt', { root })

    expect(served).toBe(false)
    expect(body).not.toContain(SECRET)
  })

  it('does not list a directory', async () => {
    const { served, res, body } = await request('/assets', { root })

    expect(served).toBe(true)
    expect(res.statusCode).not.toBe(200)
    expect(body).not.toContain('main.css')
  })

  it.runIf(fileLinksAvailable)('refuses a symlink pointing at a file outside the root', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'))

    const { served, body } = await request('/leak.txt', { root })

    expect(served).toBe(false)
    expect(body).not.toContain(SECRET)
  })

  it('refuses a file reached through a symlinked directory', async () => {
    await linkDirectory(outside, join(root, 'escape'))

    const { served, body } = await request('/escape/secret.txt', { root })

    expect(served).toBe(false)
    expect(body).not.toContain(SECRET)
  })

  it('refuses the directory link itself, not only paths beneath it', async () => {
    // lstat reports a link as a link, so this never reaches the directory
    // branch and never becomes a listing of somewhere else.
    await linkDirectory(outside, join(root, 'escape'))

    const { served, body } = await request('/escape', { root })

    expect(served).toBe(false)
    expect(body).not.toContain(SECRET)
  })

  it.runIf(fileLinksAvailable)('refuses a symlink that resolves inside the root', async () => {
    // Even a link whose target is legitimate is refused: allowing "safe" links
    // means the runtime has to decide which links are safe on every request,
    // and that decision is exactly what a swapped target attacks.
    await symlink(join(root, 'app.js'), join(root, 'alias.js'))

    const { served } = await request('/alias.js', { root })

    expect(served).toBe(false)
  })

  it.runIf(fileLinksAvailable)('refuses a broken symlink without raising', async () => {
    await symlink(join(outside, 'gone.txt'), join(root, 'dangling.txt'))

    const { served, res } = await request('/dangling.txt', { root })

    expect(served).toBe(false)
    expect(res.statusCode).not.toBe(500)
  })

  it.runIf(fileLinksAvailable)('refuses a symlink planted in the media root', async () => {
    // Media lives in DATA_DIR and is written by the admin upload path, so it is
    // the one root an authenticated but untrusted party can influence.
    const media = await mkdtemp(join(tmpdir(), 'prohvac-static-media-'))
    try {
      await symlink(join(outside, 'secret.txt'), join(media, 'photo.webp'))

      const { served, body } = await request('/photo.webp', {
        root: media,
        cacheControl: 'public, max-age=31536000, immutable',
      })

      expect(served).toBe(false)
      expect(body).not.toContain(SECRET)
    } finally {
      await rm(media, { recursive: true, force: true })
    }
  })

  it.runIf(fileLinksAvailable)('does not serve a symlinked precompressed variant', async () => {
    await writeFile(join(outside, 'evil.br'), SECRET)
    await symlink(join(outside, 'evil.br'), join(root, 'app.js.br'))

    const { served, res, body } = await request('/app.js', { root }, 'GET', {
      'accept-encoding': 'br',
    })

    expect(served).toBe(true)
    expect(res.getHeader('Content-Encoding')).toBeUndefined()
    expect(body).toBe('export const ok = true\n')
  })

  it('serves a regular precompressed variant', async () => {
    await writeFile(join(root, 'app.js.br'), 'compressed')

    const { res, body } = await request('/app.js', { root }, 'GET', { 'accept-encoding': 'br' })

    expect(res.getHeader('Content-Encoding')).toBe('br')
    expect(res.getHeader('Vary')).toBe('Accept-Encoding')
    expect(body).toBe('compressed')
  })

  it('reports a missing root as a miss rather than an error', async () => {
    const { served } = await request('/app.js', { root: join(root, 'no-such-dir') })

    expect(served).toBe(false)
  })

  // Every branch that opens a descriptor has to close it, including the ones
  // that send no body. Deleting the file afterwards proves nothing — Node opens
  // with FILE_SHARE_DELETE and unlink succeeds on Windows regardless — so the
  // handles are tracked directly instead.
  const trackHandles = async (run) => {
    const handles = []
    const open = fsp.open.bind(fsp)
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      handles.push(handle)
      return handle
    })

    try {
      await run()
    } finally {
      spy.mockRestore()
    }

    // closeQuietly does not await, so give the pending close a turn.
    await new Promise((resolve) => setImmediate(resolve))
    return handles
  }

  it.each([
    ['a body', 'GET'],
    ['headers only', 'HEAD'],
  ])('closes the descriptor after answering with %s', async (_name, method) => {
    const handles = await trackHandles(async () => {
      const { served } = await request('/assets/main.css', { root }, method)
      expect(served).toBe(true)
    })

    expect(handles).toHaveLength(1)
    await expect(handles[0].stat()).rejects.toThrow()
  })

  it('closes the descriptor of a 304 that sends no body', async () => {
    const first = await request('/assets/main.css', { root })

    const handles = await trackHandles(async () => {
      const { res } = await request('/assets/main.css', { root }, 'GET', {
        'if-none-match': first.res.getHeader('ETag'),
      })
      expect(res.statusCode).toBe(304)
    })

    expect(handles).toHaveLength(1)
    await expect(handles[0].stat()).rejects.toThrow()
  })

  it('closes the descriptor of the plain file it abandoned for a variant', async () => {
    await writeFile(join(root, 'app.js.br'), 'compressed')

    const handles = await trackHandles(async () => {
      const { res } = await request('/app.js', { root }, 'GET', { 'accept-encoding': 'br' })
      expect(res.getHeader('Content-Encoding')).toBe('br')
    })

    // One for the plain file, one for the variant that replaced it.
    expect(handles).toHaveLength(2)
    for (const handle of handles) await expect(handle.stat()).rejects.toThrow()
  })

  it('serves the same file repeatedly without exhausting descriptors', async () => {
    const handles = await trackHandles(async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { served, body } = await request('/assets/main.css', { root })
        expect(served).toBe(true)
        expect(body).toBe('body{color:red}')
      }
    })

    expect(handles).toHaveLength(200)
    for (const handle of handles) await expect(handle.stat()).rejects.toThrow()
  })

  afterAll(() => {
    if (!fileLinksAvailable) {
      console.warn('[static.test] file symlink cases skipped: this platform refused to create one')
    }
  })
})

it('checks a root reached through a symlink against its resolved location', async () => {
  // The deployment switches releases by moving a symlink onto the document
  // root, so the root itself is routinely a link. Containment must be judged
  // against what it resolves to, otherwise every request under it fails.
  // A directory link is enough here, so this case runs everywhere.

  const real = await mkdtemp(join(tmpdir(), 'prohvac-static-real-'))
  const linkParent = await mkdtemp(join(tmpdir(), 'prohvac-static-link-'))
  const link = join(linkParent, 'current')
  try {
    await mkdir(dirname(join(real, 'index.js')), { recursive: true })
    await writeFile(join(real, 'index.js'), 'released')
    await linkDirectory(real, link)

    const { served, body } = await request('/index.js', { root: link })

    expect(served).toBe(true)
    expect(body).toBe('released')
  } finally {
    await rm(real, { recursive: true, force: true })
    await rm(linkParent, { recursive: true, force: true })
  }
})
