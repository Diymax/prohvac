import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RELEASE_MANIFEST,
  createReleaseManifest,
  inspectReleaseDirectory,
  verifyReleaseManifest,
} from './release-policy.mjs'

const roots = []
const fixture = () => {
  const root = join(tmpdir(), `prohvac-release-policy-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release policy', () => {
  it('accepts a minimal runtime tree with a valid manifest', () => {
    const root = fixture()
    mkdirSync(join(root, 'server'))
    writeFileSync(join(root, 'server', 'index.js'), 'export const ready = true\n')
    const manifest = createReleaseManifest(root, {
      version: '1.0.0',
      commit: 'fixture',
      buildDate: '1970-01-01T00:00:00.000Z',
      node: 'v24.0.0',
      schemaMigration: '004_lead_delivery_attempts.sql',
    })
    writeFileSync(join(root, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    expect(inspectReleaseDirectory(root)).toEqual([])
    expect(verifyReleaseManifest(root)).toEqual([])
  })

  it.each([
    ['.env.local', 'environment_file'],
    ['app.sqlite', 'runtime_database'],
    ['upload.test.js', 'test_file'],
    ['nested.tar.gz', 'nested_archive'],
    ['bundle.js.map', 'source_map'],
    ['private.pem', 'private_key_file'],
  ])('rejects forbidden path %s without reading a secret value', (name, type) => {
    const root = fixture()
    writeFileSync(join(root, name), 'fixture')
    expect(inspectReleaseDirectory(root)).toContainEqual({ type, path: name })
  })

  it('reports only secret type and path', () => {
    const root = fixture()
    const token = `${'123456789'}:${'A'.repeat(35)}`
    writeFileSync(join(root, 'config.json'), JSON.stringify({ token }))
    const findings = inspectReleaseDirectory(root)
    expect(findings).toEqual([{ type: 'telegram_bot_token', path: 'config.json' }])
    expect(JSON.stringify(findings)).not.toContain(token)
  })

  it('detects a changed file after manifest creation', () => {
    const root = fixture()
    writeFileSync(join(root, 'app.cjs'), 'first')
    writeFileSync(
      join(root, RELEASE_MANIFEST),
      JSON.stringify(createReleaseManifest(root, { version: '1' }))
    )
    writeFileSync(join(root, 'app.cjs'), 'second')
    expect(verifyReleaseManifest(root)).toContainEqual({
      type: 'manifest_checksum_mismatch',
      path: 'app.cjs',
    })
  })
  it('rejects a symbolic link instead of following it', () => {
    // A link in a release escapes the release root when the archive is
    // extracted and, once deployed, would defeat the containment check in
    // server/http/static.js. Where it points is deliberately not reported.
    const root = fixture()
    const outside = fixture()
    writeFileSync(join(outside, 'secret.txt'), 'outside the release')
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    } catch {
      // Windows refuses file symlinks without elevation; a directory junction
      // exercises the same lstat branch.
      symlinkSync(outside, join(root, 'leak.txt'), 'junction')
    }

    const findings = inspectReleaseDirectory(root)

    expect(findings).toContainEqual({ type: 'symbolic_link', path: 'leak.txt' })
    expect(JSON.stringify(findings)).not.toContain('outside the release')
  })

  it('does not descend into a linked directory or hash its contents', () => {
    const root = fixture()
    const outside = fixture()
    mkdirSync(join(outside, 'deep'))
    writeFileSync(join(outside, 'deep', 'app.sqlite'), 'runtime database')
    symlinkSync(outside, join(root, 'linked'), 'junction')

    const findings = inspectReleaseDirectory(root)

    // Only the link itself is reported: the walk never enters it, so the
    // database behind it never becomes a manifest entry either.
    expect(findings).toEqual([{ type: 'symbolic_link', path: 'linked' }])
    expect(createReleaseManifest(root, { version: '1' }).files).toEqual([])
  })
})
