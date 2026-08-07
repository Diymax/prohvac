import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { gzipSync } from 'node:zlib'
import { basename, dirname, join, relative } from 'node:path'

import {
  RELEASE_MANIFEST,
  assertReleaseDirectory,
  createReleaseManifest,
} from './release-policy.mjs'

const ROOT = process.cwd()
const OUTPUT = join(ROOT, 'release')
const TEMP_OUTPUT = join(ROOT, `.release-build-${randomUUID()}`)
const STAGE = join(TEMP_OUTPUT, 'app')
const ARCHIVE = join(TEMP_OUTPUT, 'prohvac-release.tar.gz')
const SOURCE_DATE_EPOCH = Number.parseInt(process.env.SOURCE_DATE_EPOCH || '0', 10)
const BUILD_EPOCH = Number.isSafeInteger(SOURCE_DATE_EPOCH) && SOURCE_DATE_EPOCH >= 0
  ? SOURCE_DATE_EPOCH
  : 0

const SOURCE_PAYLOAD = Object.freeze([
  'dist',
  'server',
  'shared',
  // CR-036: каталога api/ больше нет — конвейер заявки переехал в
  // server/application/lead-pipeline.js, потому что платформы монтируют api/
  // как serverless-функции и создавали второй production-рантайм.
  'scripts/admin-cli.mjs',
  'scripts/seed-content.mjs',
  // Проверка боевого сайта запускается ПОСЛЕ выкладки и с той же машины,
  // где лежит релиз: заставлять оператора добывать её из репозитория значит
  // гарантировать, что проверку пропустят. Скрипт только читает — заявок
  // не отправляет и в чат не пишет.
  'scripts/verify-live.mjs',
  'public/locales',
  'src/assets/design',
  'docs',
  'README.md',
  '.env.example',
  'app.cjs',
])

const runNpmBuild = () => {
  // npm.cmd cannot be passed directly to spawnSync on current Windows Node
  // releases without a shell (EINVAL). npm exposes its JS entrypoint to every
  // lifecycle script, so execute that entrypoint with this exact Node binary.
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    return
  }
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
}

const generatedFileAllowed = (source) => {
  const normalized = source.replaceAll('\\', '/')
  if (/(^|\/)__tests__(\/|$)/.test(normalized)) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return false
  if (normalized.endsWith('.map')) return false
  return true
}

const copyPayload = (item) => {
  const source = join(ROOT, item)
  if (!existsSync(source)) throw new Error(`Required release payload is missing: ${item}`)
  const target = join(STAGE, item)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, {
    recursive: true,
    filter: (candidate) => generatedFileAllowed(relative(ROOT, candidate)),
  })
}

const runtimePackage = (sourcePackage) => ({
  name: sourcePackage.name,
  private: true,
  version: sourcePackage.version,
  type: 'module',
  engines: { node: '>=22.13 <25' },
  scripts: {
    start: 'node app.cjs',
    'seed:dry-run': 'node scripts/seed-content.mjs --dry-run',
    seed: 'node scripts/seed-content.mjs',
  },
})

const runtimeLock = (pkg) => ({
  name: pkg.name,
  version: pkg.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: pkg.name,
      version: pkg.version,
      engines: pkg.engines,
    },
  },
})

const latestMigration = () =>
  readdirSync(join(STAGE, 'server', 'db', 'migrations'))
    .filter((name) => /^\d{3,}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .at(-1) || null

const commitHash = () => {
  if (!existsSync(join(ROOT, '.git'))) return 'unavailable'
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, stdio: 'pipe' })
    .toString()
    .trim()
  if (status && process.env.ALLOW_DIRTY_RELEASE !== '1') {
    throw new Error('Release must be built from a clean checkout (set ALLOW_DIRTY_RELEASE=1 only for diagnostics)')
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'pipe' })
    .toString()
    .trim()
}

const writeOctal = (buffer, offset, length, value) => {
  const encoded = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0')
  buffer.write(encoded.slice(-(length - 1)), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

const tarHeader = ({ name, size, mode, type, mtime }) => {
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path is too long: ${name}`)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = checksum.toString(8).padStart(6, '0')
  header.write(checksumText, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

const tarEntries = (root) => {
  const entries = []
  const visit = (path) => {
    const names = readdirSync(path).sort((a, b) => a.localeCompare(b, 'en'))
    for (const name of names) {
      const target = join(path, name)
      const stat = statSync(target)
      const archiveName = `app/${relative(root, target).replaceAll('\\', '/')}`
      if (stat.isDirectory()) {
        entries.push({ name: `${archiveName}/`, path: target, directory: true })
        visit(target)
      } else if (stat.isFile()) {
        entries.push({ name: archiveName, path: target, directory: false })
      } else {
        throw new Error(`Unsupported release entry: ${target}`)
      }
    }
  }
  visit(root)
  return entries
}

const buildArchive = (root, target) => {
  const chunks = []
  for (const entry of tarEntries(root)) {
    const content = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path)
    chunks.push(
      tarHeader({
        name: entry.name,
        size: content.length,
        mode: entry.directory ? 0o755 : 0o644,
        type: entry.directory ? '5' : '0',
        mtime: BUILD_EPOCH,
      })
    )
    if (!entry.directory) {
      chunks.push(content)
      const padding = (512 - (content.length % 512)) % 512
      if (padding) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(1024))
  writeFileSync(target, gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }))
}

const deploymentGuide = `# PROHVAC release

This archive is generated and verified. Do not overlay it onto an unknown tree.

1. Back up the external DATA_DIR (SQLite, WAL/SHM, and media).
2. Extract into a new version directory.
3. Run \`npm ci --omit=dev\` (the runtime package intentionally has zero dependencies).
4. Configure environment variables documented in README/.env.example.
5. Run \`node scripts/seed-content.mjs --dry-run\` on first deployment, then seed if required.
6. Start \`app.cjs\`, run health/smoke checks, then switch the symlink/document root.
7. Keep the previous version for rollback; never delete the live tree recursively in place.

Verify before upload:

    npm run verify:release
`

const publish = () => {
  const backup = join(ROOT, `.release-backup-${process.pid}`)
  let backedUp = false
  try {
    if (existsSync(OUTPUT)) {
      renameSync(OUTPUT, backup)
      backedUp = true
    }
    renameSync(TEMP_OUTPUT, OUTPUT)
    if (backedUp) rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(OUTPUT) && backedUp && existsSync(backup)) renameSync(backup, OUTPUT)
    throw error
  }
}

try {
  // CR-058. Прошлый артефакт удаляем ДО сборки. Иначе неудачная сборка
  // оставляет рядом архив предыдущего запуска, и `verify:release`,
  // запущенный отдельно, честно подтверждает устаревший релиз — ровно так
  // сломанная сборка один раз прошла проверку в этой итерации.
  rmSync(join(OUTPUT, basename(ARCHIVE)), { force: true })
  rmSync(join(OUTPUT, RELEASE_MANIFEST), { force: true })

  runNpmBuild()
  mkdirSync(STAGE, { recursive: true })
  for (const item of SOURCE_PAYLOAD) copyPayload(item)

  const sourcePackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const pkg = runtimePackage(sourcePackage)
  writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(STAGE, 'package-lock.json'), `${JSON.stringify(runtimeLock(pkg), null, 2)}\n`)

  const manifest = createReleaseManifest(STAGE, {
    version: sourcePackage.version,
    commit: commitHash(),
    buildDate: new Date(BUILD_EPOCH * 1_000).toISOString(),
    node: process.version,
    schemaMigration: latestMigration(),
  })
  writeFileSync(join(STAGE, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  assertReleaseDirectory(STAGE)

  writeFileSync(join(TEMP_OUTPUT, 'DEPLOY.md'), deploymentGuide)
  buildArchive(STAGE, ARCHIVE)
  cpSync(join(STAGE, RELEASE_MANIFEST), join(TEMP_OUTPUT, RELEASE_MANIFEST))
  // Do not retain an unpacked source copy beside the archive. Besides wasting
  // space, that duplicate tree is easy to deploy accidentally and makes secret
  // scans inspect the same runtime twice.
  rmSync(STAGE, { recursive: true, force: true })
  publish()

  console.log(`Release: ${join(OUTPUT, basename(ARCHIVE))}`)
  console.log(`Manifest: ${join(OUTPUT, RELEASE_MANIFEST)}`)
} catch (error) {
  rmSync(TEMP_OUTPUT, { recursive: true, force: true })
  throw error
}
