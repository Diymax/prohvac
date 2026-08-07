import { buildOperationsDashboard } from '../application/operations-dashboard.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { json } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'
import { resolveMediaQuota } from './admin.media.js'
import { resolveTelegram } from './admin.settings.js'

export const registerAdminOperationsRoutes = (router, deps = {}) => {
  const { db } = deps
  if (!db) throw new TypeError('admin.operations: нужен deps.db')

  router.register('GET', '/api/admin/overview', async (req, res) => {
    ensureRequestContext(req)
    const access = requireActive(db, req)
    if (!access.ok) return denyAsNotFound(req, res)
    if (!hasCapability(access.user, CAPABILITY.DASHBOARD_READ)) {
      return json(res, 403, { ok: false, error: 'forbidden' })
    }

    const dashboard = buildOperationsDashboard({
      db,
      user: access.user,
      telegram: resolveTelegram(db),
      translateStatus: deps.translateStatus,
      mediaQuotaBytes: resolveMediaQuota(db),
      dataDir: config.dataDir,
      runtimeStatus: typeof deps.runtimeStatus === 'function' ? deps.runtimeStatus() : null,
    })
    return json(res, 200, { ok: true, dashboard })
  })
}
