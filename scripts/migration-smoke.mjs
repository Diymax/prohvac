import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSqliteDriver } from '../server/db/driver.js'
import { MIGRATIONS_DIR, runMigrations } from '../server/db/migrate.js'

const root = mkdtempSync(join(tmpdir(), 'prohvac-migration-smoke-'))

const verify = (db) => {
  const migrations = db.all('SELECT name FROM schema_migrations ORDER BY name').map((row) => row.name)
  if (!migrations.includes('004_lead_delivery_attempts.sql')) {
    throw new Error('latest migration was not applied')
  }
  const states = db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_delivery_attempts'"
  )?.sql
  if (!states?.includes('delivery_unknown')) throw new Error('delivery state schema is incomplete')
}

try {
  const fresh = createSqliteDriver(join(root, 'fresh.sqlite'))
  const first = runMigrations(fresh)
  if (!first.length || runMigrations(fresh).length) throw new Error('migration runner is not idempotent')
  verify(fresh)
  fresh.close()

  const upgrade = createSqliteDriver(join(root, 'upgrade.sqlite'))
  upgrade.exec(readFileSync(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8'))
  const applied = runMigrations(upgrade)
  if (!applied.includes('002_drop_rate_counters.sql')) throw new Error('existing schema was not upgraded')
  verify(upgrade)
  upgrade.close()

  console.log('Migration smoke passed: fresh schema and 001 upgrade')
} finally {
  rmSync(root, { recursive: true, force: true })
}
