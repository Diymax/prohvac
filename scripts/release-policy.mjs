import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'

export const RELEASE_MANIFEST = 'RELEASE_MANIFEST.json'

const normalized = (value) => value.replaceAll('\\', '/')

/**
 * Walks the release tree without ever following a symbolic link.
 *
 * lstat, not stat: a link is reported as itself instead of as whatever it
 * points at. That matters twice over. A link inside the archive escapes the
 * release root at extraction time and lands a file wherever it aims, and a
 * link the runtime later serves would bypass the containment check in
 * server/http/static.js. Neither belongs in a release, so the tree is walked
 * as it is on disk and links are reported rather than resolved.
 */
const walkEntries = (root) => {
  const entries = []
  const visit = (path) => {
    for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b, 'en'))) {
      const target = join(path, name)
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) {
        // Not descended into and not hashed: a broken link has nothing to read,
        // and a link to a directory would duplicate a subtree or loop forever.
        entries.push({ target, symbolicLink: true })
        continue
      }
      if (stat.isDirectory()) visit(target)
      else entries.push({ target, symbolicLink: false })
    }
  }
  visit(root)
  return entries
}

const walk = (root) =>
  walkEntries(root).filter((entry) => !entry.symbolicLink).map((entry) => entry.target)

const pathViolation = (path) => {
  const lower = normalized(path).toLowerCase()
  const parts = lower.split('/')
  const name = parts.at(-1) || ''

  if (name.startsWith('.env') && name !== '.env.example') return 'environment_file'
  if (parts.some((part) => ['node_modules', 'uploads', 'coverage', 'test-results',
    'playwright-report', '.nyc_output', 'logs', '__tests__', 'fixtures'].includes(part))) {
    return 'forbidden_directory'
  }
  if (/(^|\/).+\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return 'test_file'
  if (/\.(sqlite|sqlite3|db)(-(wal|shm))?$/.test(name) || /-(wal|shm)$/.test(name)) {
    return 'runtime_database'
  }
  if (/\.(zip|tgz|tar|tar\.gz|7z|rar)$/.test(name)) return 'nested_archive'
  if (name.endsWith('.map')) return 'source_map'
  if (/\.(tmp|temp|part|log)$/.test(name)) return 'temporary_or_log_file'
  if (/\.(pem|key|p12|pfx)$/.test(name)) return 'private_key_file'
  return null
}

const SECRET_PATTERNS = Object.freeze([
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['telegram_bot_token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/],
  ['openai_style_token', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['google_api_key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  [
    'assigned_application_secret',
    /\b(?:APP_SECRET|GATE_SECRET|TELEGRAM_BOT_TOKEN|DEEPL_API_KEY)\s*=\s*["']?[A-Za-z0-9_:/+=.-]{24,}/,
  ],
])

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.txt',
])

const scanSecretTypes = (file) => {
  if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) return []
  const stat = statSync(file)
  if (stat.size > 2 * 1024 * 1024) return []
  const text = readFileSync(file, 'utf8')
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([type]) => type)
}

export const sha256File = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex')

export const listReleaseFiles = (root, { includeManifest = false } = {}) =>
  walk(root)
    .map((file) => normalized(relative(root, file)))
    .filter((file) => includeManifest || file !== RELEASE_MANIFEST)
    .sort((a, b) => a.localeCompare(b, 'en'))

export const createReleaseManifest = (root, metadata) => ({
  formatVersion: 1,
  ...metadata,
  files: listReleaseFiles(root).map((path) => ({
    path,
    sha256: sha256File(join(root, path)),
    bytes: statSync(join(root, path)).size,
  })),
})

export const inspectReleaseDirectory = (root) => {
  const findings = []
  for (const entry of walkEntries(root)) {
    const path = normalized(relative(root, entry.target))
    if (entry.symbolicLink) {
      // Where the link points is deliberately not reported: the target is
      // outside the release and its path is not the operator's to leak.
      findings.push({ type: 'symbolic_link', path })
      continue
    }
    const violation = pathViolation(path)
    if (violation) findings.push({ type: violation, path })
    for (const type of scanSecretTypes(entry.target)) findings.push({ type, path })
  }
  return findings
}

export const verifyReleaseManifest = (root) => {
  const path = join(root, RELEASE_MANIFEST)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return [{ type: 'manifest_missing_or_invalid', path: RELEASE_MANIFEST }]
  }
  if (!Array.isArray(manifest.files)) {
    return [{ type: 'manifest_files_invalid', path: RELEASE_MANIFEST }]
  }

  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]))
  const actual = listReleaseFiles(root)
  const findings = []
  for (const path of actual) {
    const entry = expected.get(path)
    if (!entry) {
      findings.push({ type: 'manifest_unlisted_file', path })
      continue
    }
    const file = join(root, path)
    if (entry.sha256 !== sha256File(file) || entry.bytes !== statSync(file).size) {
      findings.push({ type: 'manifest_checksum_mismatch', path })
    }
    expected.delete(path)
  }
  for (const path of expected.keys()) findings.push({ type: 'manifest_file_missing', path })
  return findings
}

export const formatRedactedFindings = (findings) =>
  findings.map((finding) => `${finding.type}: ${finding.path}`)

export const assertReleaseDirectory = (root) => {
  const findings = [...inspectReleaseDirectory(root), ...verifyReleaseManifest(root)]
  if (!findings.length) return
  throw new Error(
    `Release verification failed (${findings.length}):\n${formatRedactedFindings(findings).join('\n')}`
  )
}

export const forbiddenReleaseBasename = (path) => pathViolation(basename(path))
