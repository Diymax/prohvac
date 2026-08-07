import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const BLOCK = 512

const readString = (block, offset, length) => {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').trim()
}

const readOctal = (block, offset, length) => {
  const text = readString(block, offset, length)
  return text ? Number.parseInt(text, 8) : 0
}

const isEmptyBlock = (block) => block.every((byte) => byte === 0)

/**
 * Reject archive members that escape the destination directory (path traversal
 * via `..` segments, absolute paths, or Windows drive prefixes).
 */
const resolveMember = (destination, name) => {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe archive entry (absolute path): ${name}`)
  }
  const target = resolve(destination, name)
  const root = resolve(destination)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Unsafe archive entry (path traversal): ${name}`)
  }
  return target
}

/**
 * Extract a gzipped ustar archive produced by `scripts/build-release.mjs`.
 *
 * Implemented in-process on purpose: the GNU `tar` CLI treats a Windows
 * `C:\...` argument as a remote host specification, so shelling out makes
 * release verification unusable on the platform maintainers actually build on.
 *
 * @param {string} archivePath Path to the `.tar.gz`/`.tgz` archive.
 * @param {string} destination Existing directory receiving the contents.
 * @returns {string[]} Archive-relative names of the extracted members.
 */
export const extractTarGz = (archivePath, destination) => {
  const buffer = gunzipSync(readFileSync(archivePath))
  const extracted = []
  let offset = 0

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (isEmptyBlock(header)) continue

    const name = readString(header, 0, 100)
    if (!name) throw new Error('Malformed archive: entry without a name')
    const size = readOctal(header, 124, 12)
    const type = readString(header, 156, 1) || '0'
    const prefix = readString(header, 345, 155)
    const fullName = prefix ? `${prefix}/${name}` : name
    const target = resolveMember(destination, fullName)

    if (type === '5') {
      mkdirSync(target, { recursive: true })
    } else if (type === '0' || type === '') {
      if (offset + size > buffer.length) {
        throw new Error(`Malformed archive: truncated entry ${fullName}`)
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer.subarray(offset, offset + size))
    } else {
      throw new Error(`Unsupported archive entry type "${type}": ${fullName}`)
    }

    extracted.push(fullName)
    offset += Math.ceil(size / BLOCK) * BLOCK
  }

  return extracted
}

/**
 * Extract an archive and return the path of its single top-level directory.
 *
 * @param {string} archivePath Path to the archive.
 * @param {string} destination Directory receiving the contents.
 * @param {string} rootName Expected top-level directory name.
 * @returns {string} Absolute path of the extracted root directory.
 */
export const extractReleaseArchive = (archivePath, destination, rootName = 'app') => {
  const entries = extractTarGz(archivePath, destination)
  if (!entries.some((entry) => entry === `${rootName}/` || entry.startsWith(`${rootName}/`))) {
    throw new Error(`Release archive does not contain a "${rootName}/" root`)
  }
  return join(destination, rootName)
}

// --- writing -----------------------------------------------------------------
//
// The writer lives beside the reader on purpose: they encode the same ustar
// dialect, and when the two drifted apart the only symptom was an archive that
// one of them could not read.

const writeOctal = (buffer, offset, length, value) => {
  const encoded = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0')
  buffer.write(encoded.slice(-(length - 1)), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

const tarHeader = ({ name, size, mode, type, mtime }) => {
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path is too long: ${name}`)
  const header = Buffer.alloc(BLOCK)
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
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

const tarEntries = (root, prefix) => {
  const entries = []
  const visit = (path) => {
    for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b, 'en'))) {
      const target = join(path, name)
      const stat = statSync(target)
      const archiveName = `${prefix}/${relative(root, target).replaceAll('\\', '/')}`
      if (stat.isDirectory()) {
        entries.push({ name: `${archiveName}/`, path: target, directory: true })
        visit(target)
      } else if (stat.isFile()) {
        entries.push({ name: archiveName, path: target, directory: false })
      } else {
        throw new Error(`Unsupported archive entry: ${target}`)
      }
    }
  }
  visit(root)
  return entries
}

/**
 * Write a deterministic gzipped ustar archive of a directory tree.
 *
 * Entry order, mtime and gzip mtime are all fixed so that two builds of the
 * same tree produce byte-identical archives.
 *
 * @param {string} root Directory to archive.
 * @param {string} target Output `.tar.gz` path.
 * @param {{prefix?: string, mtime?: number}} [options] Archive root name and fixed mtime.
 */
export const buildTarGz = (root, target, { prefix = 'app', mtime = 0 } = {}) => {
  const chunks = []
  for (const entry of tarEntries(root, prefix)) {
    const content = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path)
    chunks.push(
      tarHeader({
        name: entry.name,
        size: content.length,
        mode: entry.directory ? 0o755 : 0o644,
        type: entry.directory ? '5' : '0',
        mtime,
      })
    )
    if (!entry.directory) {
      chunks.push(content)
      const padding = (BLOCK - (content.length % BLOCK)) % BLOCK
      if (padding) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  writeFileSync(target, gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }))
}
