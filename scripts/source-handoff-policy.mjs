// CR-057. Policy for the source handoff package.
//
// This is a different artifact from the production release, and the difference
// is not cosmetic. The release carries only what the server needs to run and
// deliberately excludes tests; the handoff carries the maintainable source and
// must therefore KEEP tests, configuration and documentation while excluding
// everything that is generated, local or secret.
//
// Keeping the two policies in separate modules is intentional: a single shared
// denylist would have to special-case tests in both directions, and that is the
// kind of condition that eventually gets inverted by accident.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

import { secretTypesIn } from './secret-patterns.mjs'

export const SOURCE_MANIFEST = 'SOURCE_MANIFEST.json'

const normalized = (value) => value.replaceAll('\\', '/')

// Directory names that are generated or machine-local wherever they appear.
const EXCLUDED_ANYWHERE = Object.freeze([
  'node_modules',
  'coverage',
  'test-results',
  'playwright-report',
  '.nyc_output',
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.vercel',
  '.netlify',
  '.cache',
  '.vite',
])

// Directories that are only generated/local AT THE REPOSITORY ROOT. Matching
// these at any depth is wrong and was caught by the first handoff build:
// `src/data/content.js` is source code, and a bare "data" rule silently dropped
// it from the package.
const EXCLUDED_AT_ROOT = Object.freeze([
  'data',
  'dist',
  'release',
  'logs',
  'uploads',
  'build',
  'out',
])

/** Every directory name the policy can exclude, for the manifest. */
export const EXCLUDED_DIRECTORIES = Object.freeze([...EXCLUDED_ANYWHERE, ...EXCLUDED_AT_ROOT])

/**
 * Why a path must not enter the handoff, or `null` if it may.
 *
 * @param {string} path Repository-relative path.
 * @returns {string|null} Machine-readable exclusion reason.
 */
export const exclusionReason = (path) => {
  const lower = normalized(path).toLowerCase()
  const parts = lower.split('/')
  const name = parts.at(-1) || ''

  if (parts.some((part) => EXCLUDED_ANYWHERE.includes(part))) return 'excluded_directory'
  if (EXCLUDED_AT_ROOT.includes(parts[0])) return 'excluded_root_directory'
  if (name.startsWith('.env') && name !== '.env.example') return 'environment_file'
  if (/\.(sqlite|sqlite3|db)(-(wal|shm))?$/.test(name) || /-(wal|shm)$/.test(name)) {
    return 'runtime_database'
  }
  if (/\.(zip|tgz|tar|7z|rar)$/.test(name) || name.endsWith('.tar.gz')) return 'archive'
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(name)) return 'private_key_file'
  if (/^id_(rsa|ed25519|ecdsa)/.test(name)) return 'private_key_file'
  if (/\.(tmp|temp|part|log|swp|swo)$/.test(name)) return 'temporary_or_log_file'
  if (name === '.ds_store' || name === 'thumbs.db' || name === 'desktop.ini') return 'os_metadata'
  if (name.endsWith('.map')) return 'source_map'
  if (name === 'npm-debug.log' || name.startsWith('npm-debug.log')) return 'temporary_or_log_file'
  return null
}

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sql',
  '.svg', '.txt', '.xml', '.yml', '.yaml', '.example', '.cfg', '.conf',
])

const isTextual = (path) => TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || !extname(path)

/**
 * Collect handoff-eligible files, skipping excluded trees entirely so a large
 * `node_modules` is never walked.
 *
 * @param {string} root Repository root.
 * @returns {{files: string[], skipped: Array<{path: string, reason: string}>, symlinks: string[]}}
 */
export const collectSourceFiles = (root) => {
  const files = []
  const skipped = []
  const symlinks = []

  const visit = (dir) => {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en'))) {
      const absolute = join(dir, name)
      const rel = normalized(relative(root, absolute))
      const reason = exclusionReason(rel)

      // lstat, not stat: a symlink must be reported as a symlink instead of
      // being silently followed into whatever it points at.
      const stat = lstatSync(absolute)

      if (stat.isSymbolicLink()) {
        symlinks.push(rel)
        continue
      }
      if (reason) {
        skipped.push({ path: rel, reason })
        continue
      }
      if (stat.isDirectory()) visit(absolute)
      else if (stat.isFile()) files.push(rel)
      else skipped.push({ path: rel, reason: 'unsupported_entry' })
    }
  }

  visit(root)
  return { files, skipped, symlinks }
}

export const sha256File = (absolute) =>
  createHash('sha256').update(readFileSync(absolute)).digest('hex')

/**
 * Scan the selected files for live credentials.
 *
 * @returns {Array<{type: string, file: string}>} Type and path only.
 */
export const scanForSecrets = (root, files) => {
  const findings = []
  for (const file of files) {
    // `.env.example` is a placeholder file by definition; it is validated by
    // shape below rather than by credential signature.
    if (!isTextual(file)) continue
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const type of secretTypesIn(text)) findings.push({ type, file })
  }
  return findings
}

/**
 * `.env.example` must document variables without carrying a usable value.
 *
 * @returns {string[]} Names of variables that look assigned rather than shown.
 */
export const inspectEnvExample = (root) => {
  let text
  try {
    text = readFileSync(join(root, '.env.example'), 'utf8')
  } catch {
    return []
  }

  const suspicious = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, name, rawValue] = match
    const value = rawValue.trim().replace(/^["']|["']$/g, '')
    if (!value) continue
    // Long opaque strings are what a real credential looks like; readable
    // placeholders such as http://localhost:5173 or 127.0.0.1/32 are fine.
    if (value.length >= 24 && !/[\s/:.,]/.test(value)) suspicious.push(name)
  }
  return suspicious
}

/**
 * Full policy evaluation for a candidate handoff root.
 *
 * @returns {{files: string[], skipped: Array, symlinks: string[], secrets: Array, envExample: string[]}}
 */
export const inspectSourceTree = (root) => {
  const { files, skipped, symlinks } = collectSourceFiles(root)
  return {
    files,
    skipped,
    symlinks,
    secrets: scanForSecrets(root, files),
    envExample: inspectEnvExample(root),
  }
}
