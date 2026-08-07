import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

import { extractReleaseArchive } from './release-archive.mjs'
import { assertReleaseDirectory } from './release-policy.mjs'

const target = resolve(process.argv[2] || 'release/prohvac-release.tar.gz')
const stat = statSync(target)

if (stat.isDirectory()) {
  assertReleaseDirectory(target)
  console.log(`Release verified: ${target}`)
  process.exit(0)
}

const temporary = mkdtempSync(join(tmpdir(), 'prohvac-release-verify-'))
try {
  if (!['.gz', '.tgz'].includes(extname(target).toLowerCase())) {
    throw new Error('Archive verification supports .tar.gz/.tgz only')
  }
  assertReleaseDirectory(extractReleaseArchive(target, temporary))
  console.log(`Release archive verified: ${target}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
