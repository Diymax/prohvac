// Конвертирует исходники дизайна в WebP с ограничением по ширине.
// Запуск: npm run optimize:images -- <исходная-папка> <целевая-папка>
import { readdir, mkdir, copyFile, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import sharp from 'sharp'

const [srcDir, outDir] = process.argv.slice(2)
if (!srcDir || !outDir) {
  console.error('Использование: node scripts/optimize-images.mjs <src> <out>')
  process.exit(1)
}

// Только те файлы, которые реально используются в макете.
const KEEP = new Set([
  'logo.png', 'logo-mark.png', 'hero-install.png', 'stats-units.png',
  'adv-1.png', 'adv-2.png', 'adv-3.png', 'adv-4.png',
  'pr-1.jpg', 'pr-2.jpg', 'pr-3.jpg', 'pr-4.jpg', 'pr-5.jpg', 'pr-6.jpg',
  'br-shivaki.png', 'br-aux.jpeg', 'br-toshiba.png', 'br-hisense.png',
  'br-mitsubishi.svg', 'br-akfa.png', 'br-koc.png', 'br-discover.png',
  'w1.jpg', 'w2.jpg', 'w3.jpg', 'w4.jpg', 'w5.jpg',
  'roof-units.jpg', 'opera-ext.jpg', 'facade-units.jpg',
  'crew-roof.jpg', 'boiler-ferroli.jpg',
])

// Логотипы и иконки должны сохранить прозрачность и резкость.
const MAX_WIDTH = { logo: 640, mark: 512, icon: 160, photo: 1920 }

const widthFor = (name) => {
  if (name.startsWith('logo-mark')) return MAX_WIDTH.mark
  if (name.startsWith('logo')) return MAX_WIDTH.logo
  if (name.startsWith('adv-')) return MAX_WIDTH.icon
  if (name.startsWith('br-')) return MAX_WIDTH.logo
  return MAX_WIDTH.photo
}

let entries
try {
  entries = await readdir(srcDir)
} catch (error) {
  console.error(`Не удалось прочитать папку с исходниками: ${srcDir}`)
  console.error(error.message)
  process.exit(1)
}

await mkdir(outDir, { recursive: true })

let before = 0
let after = 0
let processed = 0

for (const file of entries) {
  if (!KEEP.has(file)) continue
  const src = join(srcDir, file)
  before += (await stat(src)).size
  processed += 1

  // SVG векторный — трогать не нужно.
  if (extname(file).toLowerCase() === '.svg') {
    const dest = join(outDir, file)
    await copyFile(src, dest)
    after += (await stat(dest)).size
    continue
  }

  const name = basename(file, extname(file))
  const dest = join(outDir, `${name}.webp`)
  const image = sharp(src)
  const { width } = await image.metadata()
  const target = widthFor(file)

  await image
    .resize({ width: Math.min(width ?? target, target), withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toFile(dest)

  after += (await stat(dest)).size
}

if (processed === 0) {
  console.error(`Ни один файл из списка KEEP не найден в ${srcDir} — нечего обрабатывать.`)
  process.exit(1)
}

const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(`Обработано файлов: ${processed}`)
console.log(`Было:  ${mb(before)} МБ`)
console.log(`Стало: ${mb(after)} МБ`)
console.log(`Экономия: ${(100 - (after / before) * 100).toFixed(1)}%`)
