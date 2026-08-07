// CR-036. Один эндпоинт — один production-рантайм.
//
// До третьей итерации у `/api/lead` их было два: маршрут Node-приложения
// с SQLite, долговечными попытками доставки и идемпотентностью — и модуль
// `api/lead.js`, который платформы вроде Vercel монтируют автоматически,
// с настройками из окружения, лимитером в памяти процесса и без сохранения
// заявки. Расхождение такого рода не видно в тестах: оба пути отвечают 200.
//
// Скрипт падает, если такой второй рантайм появляется снова.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

/** Дескрипторы serverless-платформ: их наличие само по себе создаёт второй рантайм. */
const FORBIDDEN_DESCRIPTORS = [
  'vercel.json',
  'netlify.toml',
  'now.json',
  join('.vercel', 'project.json'),
]

/** Каталоги, которые платформы монтируют как функции по соглашению об именах. */
const FORBIDDEN_FUNCTION_DIRS = ['api', join('netlify', 'functions'), join('functions')]

/** Каталоги, где ищем случайно вернувшийся handler по умолчанию. */
const SCAN_DIRS = ['server', 'shared', 'scripts']

const problems = []

for (const descriptor of FORBIDDEN_DESCRIPTORS) {
  if (existsSync(join(ROOT, descriptor))) {
    problems.push(`serverless deployment descriptor present: ${descriptor}`)
  }
}

for (const dir of FORBIDDEN_FUNCTION_DIRS) {
  const path = join(ROOT, dir)
  if (existsSync(path) && statSync(path).isDirectory()) {
    problems.push(`platform-mounted function directory present: ${dir}/`)
  }
}

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path)
      continue
    }
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue

    const source = readFileSync(path, 'utf8')
    // Обработчик по умолчанию — это то, что платформа вызывает без явной
    // регистрации маршрута, то есть ровно механизм второго рантайма.
    if (/^export default (?:async )?(?:function|\(|createLeadHandler)/m.test(source)) {
      problems.push(`request handler exported as default: ${relative(ROOT, path)}`)
    }
  }
}

for (const dir of SCAN_DIRS) {
  const path = join(ROOT, dir)
  if (existsSync(path)) walk(path)
}

if (problems.length > 0) {
  console.error('Divergent production deployment model detected:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '\nThe Node application in server/ is the only supported production runtime.\n' +
    'See docs/DEPLOYMENT.md and TODO_CODE_REVIEW.md CR-036.'
  )
  process.exit(1)
}

console.log('Deployment model verified: one production runtime (Node application)')
