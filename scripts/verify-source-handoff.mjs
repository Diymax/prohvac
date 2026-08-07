// CR-057. Verify the source handoff package.
//
// The builder applies the policy; this script proves the shipped archive
// actually matches it. The two are separate on purpose — a gate that only ever
// runs inside the producer cannot catch an artifact that was assembled some
// other way.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

import { extractReleaseArchive } from './release-archive.mjs'
import { formatRedactedFindings } from './secret-patterns.mjs'
import { SOURCE_MANIFEST, inspectSourceTree, sha256File } from './source-handoff-policy.mjs'

/** Files that must be present, or the archive is not a maintainable source tree. */
const REQUIRED = Object.freeze([
  'package.json',
  'package-lock.json',
  'README.md',
  '.env.example',
  join('server', 'index.js'),
  join('server', 'db', 'migrate.js'),
  join('shared', 'lead.js'),
])

/** Tests are the difference between this artifact and the release: they must be here. */
const REQUIRED_PATTERN = /\.test\.jsx?$/

const target = resolve(process.argv[2] || join('release', 'prohvac-source.tar.gz'))
const problems = []

const verifyTree = (root) => {
  const inspection = inspectSourceTree(root)

  for (const link of inspection.symlinks) problems.push(`symbolic link present: ${link}`)
  for (const { type, file } of inspection.secrets) problems.push(`credential (${type}) in ${file}`)
  for (const name of inspection.envExample) {
    problems.push(`.env.example carries an assigned-looking value for ${name}`)
  }

  // inspectSourceTree skips forbidden entries rather than reporting them as
  // errors, because it is also used to build the package. For verification the
  // same list must be empty: nothing forbidden may be inside the archive.
  for (const { path, reason } of inspection.skipped) {
    problems.push(`forbidden entry (${reason}): ${path}`)
  }

  const present = new Set(inspection.files.map((file) => file.replaceAll('\\', '/')))
  for (const required of REQUIRED) {
    if (!present.has(required.replaceAll('\\', '/'))) problems.push(`missing required file: ${required}`)
  }
  if (![...present].some((file) => REQUIRED_PATTERN.test(file))) {
    problems.push('no test files present — a source handoff must ship its tests')
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, SOURCE_MANIFEST), 'utf8'))
  } catch {
    problems.push(`missing or unreadable ${SOURCE_MANIFEST}`)
    return
  }

  if (manifest.artifact !== 'source-handoff') {
    problems.push(`manifest declares the wrong artifact: ${manifest.artifact}`)
  }

  const listed = new Map(manifest.files.map((entry) => [entry.path.replaceAll('\\', '/'), entry.sha256]))
  for (const file of present) {
    if (file === SOURCE_MANIFEST) continue
    const expected = listed.get(file)
    if (!expected) {
      problems.push(`file not covered by the manifest: ${file}`)
      continue
    }
    if (sha256File(join(root, file)) !== expected) problems.push(`checksum mismatch: ${file}`)
    listed.delete(file)
  }
  for (const missing of listed.keys()) problems.push(`manifest lists a missing file: ${missing}`)
}

let temporary = null
try {
  const stat = statSync(target)
  if (stat.isDirectory()) {
    verifyTree(target)
  } else {
    if (!['.gz', '.tgz'].includes(extname(target).toLowerCase())) {
      throw new Error('Source handoff verification supports .tar.gz/.tgz only')
    }
    temporary = mkdtempSync(join(tmpdir(), 'prohvac-source-verify-'))
    verifyTree(extractReleaseArchive(target, temporary, 'source'))
  }
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`Source handoff verification failed: ${target}`)
  // Credentials are reported by type and path; the value is never printed.
  const secrets = problems.filter((problem) => problem.startsWith('credential ('))
  for (const problem of problems) {
    if (!secrets.includes(problem)) console.error(`  - ${problem}`)
  }
  if (secrets.length > 0) {
    console.error(formatRedactedFindings(secrets.map((problem) => ({ type: 'credential', file: problem }))))
    console.error('Rotate the affected credentials.')
  }
  process.exit(1)
}

console.log(`Source handoff verified: ${target}`)
