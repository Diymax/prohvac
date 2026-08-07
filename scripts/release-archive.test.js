import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { extractReleaseArchive, extractTarGz } from './release-archive.mjs'

const roots = []
const fixture = () => {
  const root = join(tmpdir(), `prohvac-release-archive-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const writeOctal = (buffer, offset, length, value) => {
  const encoded = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0')
  buffer.write(encoded.slice(-(length - 1)), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

const header = ({ name, size = 0, type = '0' }) => {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  writeOctal(block, 100, 8, type === '5' ? 0o755 : 0o644)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, size)
  writeOctal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  block.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  block[154] = 0
  block[155] = 0x20
  return block
}

const archive = (root, entries) => {
  const chunks = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8')
    chunks.push(header({ name: entry.name, size: content.length, type: entry.type ?? '0' }))
    if ((entry.type ?? '0') !== '5') {
      chunks.push(content)
      const padding = (512 - (content.length % 512)) % 512
      if (padding) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(1024))
  const path = join(root, 'fixture.tar.gz')
  writeFileSync(path, gzipSync(Buffer.concat(chunks)))
  return path
}

describe('release archive extraction', () => {
  it('restores directories and file contents', () => {
    const root = fixture()
    const path = archive(root, [
      { name: 'app/', type: '5' },
      { name: 'app/server/', type: '5' },
      { name: 'app/server/index.js', content: 'export const ready = true\n' },
    ])
    const destination = fixture()

    const appRoot = extractReleaseArchive(path, destination)

    expect(readFileSync(join(appRoot, 'server', 'index.js'), 'utf8')).toBe(
      'export const ready = true\n'
    )
  })

  it('creates parent directories for entries without an explicit directory header', () => {
    const root = fixture()
    const path = archive(root, [{ name: 'app/docs/DEPLOY.md', content: '# deploy\n' }])
    const destination = fixture()

    extractReleaseArchive(path, destination)

    expect(readFileSync(join(destination, 'app', 'docs', 'DEPLOY.md'), 'utf8')).toBe('# deploy\n')
  })

  it('rejects members that escape the destination directory', () => {
    const root = fixture()
    const path = archive(root, [{ name: 'app/../../escaped.txt', content: 'x' }])
    const destination = fixture()

    expect(() => extractTarGz(path, destination)).toThrow(/path traversal/)
  })

  it('rejects absolute member paths', () => {
    const root = fixture()
    const path = archive(root, [{ name: '/etc/passwd', content: 'x' }])
    const destination = fixture()

    expect(() => extractTarGz(path, destination)).toThrow(/absolute path/)
  })

  it('rejects an archive without the expected release root', () => {
    const root = fixture()
    const path = archive(root, [{ name: 'other/file.txt', content: 'x' }])
    const destination = fixture()

    expect(() => extractReleaseArchive(path, destination)).toThrow(/"app\/" root/)
  })

  it('rejects unsupported entry types such as symbolic links', () => {
    const root = fixture()
    const path = archive(root, [{ name: 'app/link', type: '2' }])
    const destination = fixture()

    expect(() => extractTarGz(path, destination)).toThrow(/Unsupported archive entry type/)
  })
})
