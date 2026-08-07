import { statfsSync } from 'node:fs'

import { readMaintenanceStatus } from '../lib/maintenance.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'

// Насколько проход уборки должен просрочиться, чтобы это стало
// предупреждением. Шесть часов при суточном интервале — это уже не «тик
// разошёлся», а «проход не состоялся».
const MAINTENANCE_OVERDUE_MS = 6 * 60 * 60 * 1000

const count = (db, sql, params = []) => Number(db.get(sql, params)?.n) || 0

const diskSpace = (path) => {
  try {
    const stats = statfsSync(path, { bigint: true })
    return {
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    }
  } catch {
    return null
  }
}

/**
 * Operational summary without PII or secret material.
 * Capability filtering lives here, not in React, so a crafted request cannot
 * reveal aggregates that the current role is not allowed to inspect.
 */
export const buildOperationsDashboard = ({
  db,
  user,
  telegram,
  translateStatus = () => ({}),
  mediaQuotaBytes,
  dataDir,
  runtimeStatus = null,
  now = Date.now(),
}) => {
  if (!db || !user) throw new TypeError('operations dashboard requires db and user')

  const result = {
    generatedAt: now,
    warnings: [],
  }

  if (hasCapability(user, CAPABILITY.LEADS_READ)) {
    result.leads = {
      new: count(db, "SELECT COUNT(*) AS n FROM leads WHERE status = 'new'"),
      failed: count(db, "SELECT COUNT(*) AS n FROM leads WHERE delivery_state = 'failed'"),
      deliveryUnknown: count(
        db,
        "SELECT COUNT(*) AS n FROM leads WHERE delivery_state = 'delivery_unknown'"
      ),
      // CR-032. Восстановленные попытки считаем отдельно: это не рядовое
      // «не доставлено», а следствие сбоя фиксации после успеха Telegram, и
      // оператор обязан сверить чат прежде, чем подтверждать повтор.
      recovered: count(
        db,
        'SELECT COUNT(*) AS n FROM lead_delivery_attempts WHERE recovered_at IS NOT NULL'
      ),
      stranded: count(
        db,
        `SELECT COUNT(*) AS n FROM lead_delivery_attempts
          WHERE state IN ('pending', 'sending')`
      ),
    }

    if (result.leads.recovered > 0) {
      result.warnings.push({ code: 'delivery_recovered_unknown', section: 'leads' })
    }

    const ready = Boolean(
      telegram?.enabled && telegram?.botToken && String(telegram?.chatId || '').trim()
    )
    result.telegram = { enabled: Boolean(telegram?.enabled), ready }
    if (!ready) result.warnings.push({ code: 'telegram_not_configured', section: 'settings' })
  }

  if (hasCapability(user, CAPABILITY.CONTENT_READ)) {
    const status = translateStatus() || {}
    const lastSuccess = db.get(
      "SELECT MAX(updated_at) AS at FROM translation_jobs WHERE status = 'done'"
    )
    result.translations = {
      queued: Number(status.queued) || 0,
      running: Number(status.running) || 0,
      deferred: Number(status.deferred) || 0,
      failed: Number(status.failed) || 0,
      lastSuccessAt: Number(lastSuccess?.at) || null,
    }
    if (result.translations.failed > 0) {
      result.warnings.push({ code: 'translation_jobs_failed', section: 'content' })
    }
  }

  if (hasCapability(user, CAPABILITY.MEDIA_READ)) {
    const media = db.get(
      'SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM media WHERE deleted_at IS NULL'
    )
    const usedBytes = Number(media?.bytes) || 0
    result.media = {
      usedBytes,
      quotaBytes: mediaQuotaBytes,
      remainingBytes: Math.max(0, mediaQuotaBytes - usedBytes),
      count: Number(media?.count) || 0,
    }
    if (mediaQuotaBytes > 0 && usedBytes / mediaQuotaBytes >= 0.9) {
      result.warnings.push({ code: 'media_quota_high', section: 'media' })
    }
  }

  if (hasCapability(user, CAPABILITY.SETTINGS_MANAGE)) {
    const since = now - 24 * 60 * 60 * 1000
    result.security = {
      deniedActions24h: count(
        db,
        "SELECT COUNT(*) AS n FROM audit_log WHERE result = 'denied' AND at >= ?",
        [since]
      ),
      activeIpBlocks: count(
        db,
        'SELECT COUNT(*) AS n FROM ip_blocks WHERE blocked_until > ?',
        [now]
      ),
    }
    result.runtime = runtimeStatus
    result.disk = dataDir ? diskSpace(dataDir) : null
    if (result.security.deniedActions24h || result.security.activeIpBlocks) {
      result.warnings.push({ code: 'security_activity', section: 'security' })
    }

    // CR-043. Уборка объявляет срок хранения персональных данных
    // (leads.purge_after), поэтому её молчание — не косметика: если проход
    // не состоялся, срок не наступил. failureCategory — закрытый словарь
    // (busy/storage/readonly/corruption/schema/unknown), а не текст ошибки,
    // поэтому его безопасно показывать оператору.
    try {
      const maintenance = readMaintenanceStatus(db)
      result.maintenance = maintenance

      if (maintenance.purge?.failureStreak > 0) {
        result.warnings.push({ code: 'maintenance_failing', section: 'maintenance' })
      }
      if (
        maintenance.purge?.nextRunAt > 0 &&
        now - maintenance.purge.nextRunAt > MAINTENANCE_OVERDUE_MS
      ) {
        result.warnings.push({ code: 'maintenance_overdue', section: 'maintenance' })
      }
    } catch (error) {
      // Дашборд не должен падать целиком из-за одной секции: остальные
      // показатели оператору всё ещё нужны.
      console.warn(`[operations] maintenance status unavailable: ${error.message}`)
      result.maintenance = null
      result.warnings.push({ code: 'maintenance_unknown', section: 'maintenance' })
    }
  }

  return result
}
