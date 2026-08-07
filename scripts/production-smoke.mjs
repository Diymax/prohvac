import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const availablePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })

const dataDir = mkdtempSync(join(tmpdir(), 'prohvac-production-smoke-'))
const port = await availablePort()
const adminPath = randomBytes(16).toString('hex')
const fetchWithTimeout = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(2_000) })
const child = spawn(process.execPath, ['app.cjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    DATA_DIR: dataDir,
    PUBLIC_ORIGIN: 'https://smoke.invalid',
    // CR-049. В production localhost больше не разрешён автоматически, а smoke
    // ходит на 127.0.0.1 по случайному порту. Это не поблажка тесту, а тот же
    // шаг, который обязан сделать оператор для health check по IP: адрес
    // проверки должен быть в allowlist явно. Запись без порта разрешает любой.
    TRUSTED_HOSTS: '127.0.0.1',
    // Smoke поднимает процесс сам и ходит к нему напрямую — прокси в этой
    // схеме нет. Заявляем это явно, как обязан сделать и оператор: пустое
    // значение в проде теперь означает «забыли», и старт отвергается.
    TRUSTED_PROXY_CIDRS: 'none',
    APP_SECRET: randomBytes(32).toString('hex'),
    GATE_SECRET: randomBytes(32).toString('hex'),
    ADMIN_SECRET_PATH: adminPath,
    ADMIN_REQUIRE_GATE: '0',
    TELEGRAM_BOT_TOKEN: `${String(Math.floor(Math.random() * 900_000_000) + 100_000_000)}:${randomBytes(24).toString('base64url')}`,
    TELEGRAM_CHAT_ID: '-1000000000000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  output += chunk.toString()
})

const waitForReady = async () => {
  const deadline = Date.now() + 15_000
  let lastStatus = 0
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('production process exited before readiness')
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {
        headers: { Accept: 'text/html' },
      })
      if (response.status === 200) return
      lastStatus = response.status
    } catch {
      // Startup races are expected during this bounded probe.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`production process did not become ready (last HTTP status ${lastStatus || 'none'})`)
}

try {
  await waitForReady()
  const htmlHeaders = { Accept: 'text/html' }
  const root = await fetchWithTimeout(`http://127.0.0.1:${port}/`, { headers: htmlHeaders })
  const missing = await fetchWithTimeout(`http://127.0.0.1:${port}/definitely-missing`, { headers: htmlHeaders })
  const admin = await fetchWithTimeout(`http://127.0.0.1:${port}/${adminPath}`, { headers: htmlHeaders })
  const invalidLead = await fetchWithTimeout(`http://127.0.0.1:${port}/api/lead`, {
    method: 'POST',
    headers: { Origin: 'https://smoke.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', phone: 'invalid' }),
  })

  if (root.status !== 200 || missing.status !== 404 || admin.status !== 200) {
    throw new Error('public/admin/404 production smoke failed')
  }
  if (![400, 422].includes(invalidLead.status)) throw new Error('lead validation smoke failed')
  console.log('Production smoke passed: public, admin shell, 404, lead validation')
} catch (error) {
  const safeTail = output.split(/\r?\n/).slice(-12).join('\n')
  throw new Error(`${error.message}\nProcess output (redacted configuration):\n${safeTail}`)
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  rmSync(dataDir, { recursive: true, force: true })
}
