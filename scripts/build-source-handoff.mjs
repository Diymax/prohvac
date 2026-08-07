// CR-057. Build the source handoff package.
//
// This is NOT the production release. The release (`npm run build:release`)
// carries the minimum a server needs to run and deliberately drops tests; the
// handoff carries the maintainable source — including tests, configuration and
// documentation — so that another team can take the project over.
//
// Both are generated, both are verified, and neither may contain a live
// credential, a runtime database, uploaded media, a build output or anything
// else that belongs to one particular machine.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildTarGz } from './release-archive.mjs'
import { formatRedactedFindings } from './secret-patterns.mjs'
import {
  SOURCE_MANIFEST,
  EXCLUDED_DIRECTORIES,
  inspectSourceTree,
  sha256File,
} from './source-handoff-policy.mjs'

const ROOT = process.cwd()
const OUTPUT = join(ROOT, 'release')
const ARCHIVE_NAME = 'prohvac-source.tar.gz'

// Fixed timestamps keep two builds of the same tree byte-identical.
const BUILD_EPOCH = Number.isFinite(Number(process.env.SOURCE_DATE_EPOCH))
  ? Number(process.env.SOURCE_DATE_EPOCH)
  : 0

/**
 * Commit hash of the tree being packaged.
 *
 * The handoff is supposed to be reproducible from a clean checkout, so a
 * missing or dirty repository is recorded honestly rather than silently
 * producing an archive nobody can trace back to a revision.
 */
const commitState = () => {
  if (!existsSync(join(ROOT, '.git'))) {
    return { commit: null, reason: 'no_git_checkout' }
  }
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, stdio: 'pipe' })
      .toString()
      .trim()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'pipe' })
      .toString()
      .trim()
    if (dirty && process.env.ALLOW_DIRTY_SOURCE_HANDOFF !== '1') {
      throw new Error(
        'Source handoff must be built from a clean checkout ' +
        '(set ALLOW_DIRTY_SOURCE_HANDOFF=1 only for diagnostics)'
      )
    }
    return { commit, reason: dirty ? 'dirty_tree_allowed_by_override' : null }
  } catch (error) {
    if (error.message.startsWith('Source handoff must be built')) throw error
    return { commit: null, reason: 'git_unavailable' }
  }
}

const inspection = inspectSourceTree(ROOT)

if (inspection.symlinks.length > 0) {
  console.error('Source handoff refused: unexpected symbolic links present:')
  for (const link of inspection.symlinks) console.error(`  - ${link}`)
  process.exit(1)
}

if (inspection.secrets.length > 0) {
  // Type and path only. Printing the matched value would put the credential
  // into the CI log that is supposed to be catching it.
  console.error('Source handoff refused: credential-shaped content found:')
  console.error(formatRedactedFindings(inspection.secrets))
  console.error('\nRotate the affected credential and remove it from the tree.')
  process.exit(1)
}

if (inspection.envExample.length > 0) {
  console.error('Source handoff refused: .env.example carries assigned-looking values for:')
  for (const name of inspection.envExample) console.error(`  - ${name}`)
  process.exit(1)
}

const { commit, reason } = commitState()
const stage = mkdtempSync(join(tmpdir(), 'prohvac-source-'))

try {
  for (const file of inspection.files) {
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(ROOT, file), target, { dereference: false, errorOnExist: false })
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const manifest = {
    artifact: 'source-handoff',
    note:
      'Maintainable source, including tests. This is not the deployable ' +
      'release; build that with `npm run build:release`.',
    version: pkg.version,
    commit,
    commitUnavailableReason: reason,
    buildDate: new Date(BUILD_EPOCH * 1_000).toISOString(),
    node: process.version,
    excludedDirectories: [...EXCLUDED_DIRECTORIES],
    excluded: inspection.skipped,
    files: inspection.files.map((file) => ({
      path: file,
      sha256: sha256File(join(stage, file)),
    })),
  }
  writeFileSync(join(stage, SOURCE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)

  mkdirSync(OUTPUT, { recursive: true })
  const archive = join(OUTPUT, ARCHIVE_NAME)
  // Remove the previous artifact first: a failed build must not leave an older
  // archive that `verify:source-handoff` would happily accept (see CR-058).
  rmSync(archive, { force: true })
  buildTarGz(stage, archive, { prefix: 'source', mtime: BUILD_EPOCH })

  console.log(`Source handoff: ${archive}`)
  console.log(`Files: ${inspection.files.length}, excluded entries: ${inspection.skipped.length}`)
  if (!commit) console.warn(`Commit hash unavailable (${reason}); recorded as null in the manifest`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
