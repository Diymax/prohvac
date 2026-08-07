import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { extractReleaseArchive } from './release-archive.mjs'

const archive = resolve(process.argv[2] || 'release/prohvac-release.tar.gz')
const root = mkdtempSync(join(tmpdir(), 'prohvac-release-smoke-'))
const dataDir = join(root, 'data')

try {
  const appRoot = extractReleaseArchive(archive, root)
  execFileSync(process.execPath, ['scripts/seed-content.mjs', '--dry-run'], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: 'http://localhost:5173',
    },
    stdio: 'pipe',
  })
  console.log('Release smoke passed: archive extracts and first-deploy seed dry-run succeeds')
} finally {
  rmSync(root, { recursive: true, force: true })
}
