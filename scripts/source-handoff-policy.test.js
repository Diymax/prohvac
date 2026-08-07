import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { secretTypesIn } from './secret-patterns.mjs'
import { exclusionReason, inspectEnvExample, inspectSourceTree } from './source-handoff-policy.mjs'

// Строка, по форме совпадающая с боевым токеном Telegram, собирается из частей.
// Литерал целиком в исходнике означал бы, что собственный сканер секретов
// обязан отвергнуть этот файл — и он его отверг, когда литерал здесь был.
const tokenShaped = () => `1234567890:${'AbCdEfGhIjKlMnOpQrStUvWxYz'}0123456789`

const roots = []
const fixture = () => {
  const root = join(tmpdir(), `prohvac-handoff-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

const write = (root, relative, content = 'x\n') => {
  const target = join(root, relative)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
  return target
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('source handoff exclusion rules (CR-057)', () => {
  it('keeps source, tests, configuration and documentation', () => {
    for (const path of [
      'package.json',
      'README.md',
      '.env.example',
      'server/index.js',
      'server/auth/session.test.js',
      'src/components/Contact.jsx',
      'docs/DEPLOYMENT.md',
    ]) {
      expect(exclusionReason(path)).toBe(null)
    }
  })

  it('excludes generated and machine-local trees at any depth', () => {
    expect(exclusionReason('node_modules/react/index.js')).toBe('excluded_directory')
    expect(exclusionReason('src/.cache/x.js')).toBe('excluded_directory')
    expect(exclusionReason('.claude/project-map.md')).toBe('excluded_directory')
  })

  it('excludes generated directories only at the repository root', () => {
    expect(exclusionReason('data/app.sqlite')).toBe('excluded_root_directory')
    expect(exclusionReason('dist/index.html')).toBe('excluded_root_directory')
    expect(exclusionReason('release/prohvac-release.tar.gz')).toBe('excluded_root_directory')
    // Regression: a bare "data" rule dropped real source from the package.
    expect(exclusionReason('src/data/content.js')).toBe(null)
    expect(exclusionReason('server/db/migrations/001_init.sql')).toBe(null)
  })

  it('excludes environment files but keeps the example', () => {
    expect(exclusionReason('.env')).toBe('environment_file')
    expect(exclusionReason('.env.local')).toBe('environment_file')
    expect(exclusionReason('.env.production')).toBe('environment_file')
    expect(exclusionReason('.env.example')).toBe(null)
  })

  it('excludes runtime databases, archives, keys, logs and OS metadata', () => {
    expect(exclusionReason('app.sqlite')).toBe('runtime_database')
    expect(exclusionReason('app.sqlite-wal')).toBe('runtime_database')
    expect(exclusionReason('backup.tar.gz')).toBe('archive')
    expect(exclusionReason('server.key')).toBe('private_key_file')
    expect(exclusionReason('id_rsa')).toBe('private_key_file')
    expect(exclusionReason('debug.log')).toBe('temporary_or_log_file')
    expect(exclusionReason('.DS_Store')).toBe('os_metadata')
    expect(exclusionReason('bundle.js.map')).toBe('source_map')
  })
})

describe('source handoff tree inspection (CR-057)', () => {
  it('reports symbolic links instead of following them', () => {
    const root = fixture()
    write(root, 'server/index.js')
    const outside = fixture()
    write(outside, 'secret.txt', 'data')
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    } catch {
      // Windows without developer mode refuses symlink creation for a normal
      // user. Skipping is honest; asserting a pass we did not observe is not.
      return
    }

    const inspection = inspectSourceTree(root)
    expect(inspection.symlinks).toContain('link.txt')
    expect(inspection.files).not.toContain('link.txt')
  })

  it('never walks into an excluded directory', () => {
    const root = fixture()
    write(root, 'node_modules/react/index.js')
    write(root, 'server/index.js')

    const inspection = inspectSourceTree(root)
    expect(inspection.files).toEqual(['server/index.js'])
    expect(inspection.skipped).toEqual([{ path: 'node_modules', reason: 'excluded_directory' }])
  })

  it('reports credential-shaped content by type and path only', () => {
    const root = fixture()
    write(root, 'config.js', `const token = '${tokenShaped()}'\n`)

    const inspection = inspectSourceTree(root)
    expect(inspection.secrets).toEqual([{ type: 'telegram_bot_token', file: 'config.js' }])
    // The finding must not carry the value itself.
    expect(JSON.stringify(inspection.secrets)).not.toContain('AbCdEfGh')
  })

  it('accepts a fixture that marks itself synthetic', () => {
    expect(secretTypesIn("const t = '1234567890:NOT-A-REAL-TOKEN-TEST-FIXTURE-0000000'")).toEqual([])
    expect(secretTypesIn(`const t = '${tokenShaped()}'`)).toEqual(['telegram_bot_token'])
  })
})

describe('.env.example validation (CR-057)', () => {
  it('accepts readable placeholders', () => {
    const root = fixture()
    write(
      root,
      '.env.example',
      '# comment\nPUBLIC_ORIGIN=http://localhost:5173\nTRUSTED_PROXY_CIDRS=127.0.0.1/32\nAPP_SECRET=\n'
    )
    expect(inspectEnvExample(root)).toEqual([])
  })

  it('rejects an assigned-looking credential', () => {
    const root = fixture()
    // Маркер NOT-A-REAL-SECRET обязателен: фикстура по форме неотличима от
    // боевого значения, и без него собственный сканер секретов не пустил бы
    // этот файл в source handoff — что он один раз и сделал.
    write(root, '.env.example', 'APP_SECRET=NOT-A-REAL-SECRET-8f3a9c2b7d1e6045af92c8b3\n')
    expect(inspectEnvExample(root)).toEqual(['APP_SECRET'])
  })
})
