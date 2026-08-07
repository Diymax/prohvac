// Маршрут сводки Яндекс.Метрики для админки.
//
// ПОЧЕМУ ПРОКСИ, А НЕ ЗАПРОС ИЗ БРАУЗЕРА. Обращаться к api-metrika.yandex.net
// прямо из админки нельзя по двум причинам сразу: OAuth-токен пришлось бы
// отдать в браузер (а секреты из реестра настроек не покидают сервер никогда),
// и connect-src в нашей CSP не пускает панель ни на один сторонний адрес.
// Поэтому наружу ходит сервер, а браузер разговаривает только со своим origin.
//
// Права: чтение сводки — та же капабилити, что и у «Обзора» (dashboard.read).
// Данные агрегатные, без ПДн, и роль, которой можно показать счётчик заявок,
// вправе видеть и источники этих заявок. Управление токеном отдельной
// капабилити не требует: это ключ реестра настроек, то есть settings.manage.

import { DEFAULT_PERIOD, PERIODS, buildAnalyticsDashboard } from '../application/analytics-dashboard.js'
import { SECRET_STATE, SETTING_KEYS } from '../../shared/settings.js'
import { denyAsNotFound, requireActive } from '../auth/guard.js'
import { config } from '../config.js'
import { getSettingsService } from '../application/settings-service.js'
import { json } from '../http/respond.js'
import { ensureRequestContext } from '../http/runtime-request-context.js'
import { metricaGateway } from '../integrations/metrica.js'
import { CAPABILITY, hasCapability } from '../policies/capabilities.js'

/**
 * Токен для Stat API: строка в настройках важнее переменной окружения.
 *
 * Порядок тот же, что у токена бота (см. application/telegram-config.js):
 * окружение — умолчание деплоя, настройка — осознанное решение человека.
 * Битая запись НЕ откатывается к окружению: это явный, но нечитаемый
 * override, и молча подставить другой токен значило бы показать оператору
 * статистику не того счётчика, о чём он не узнает.
 */
export const resolveMetricaToken = (db) => {
  const stored = getSettingsService(db).readSecretState(SETTING_KEYS.METRICA_OAUTH_TOKEN)
  if (stored.state === SECRET_STATE.COMPLETE) return stored.value
  if (stored.state === SECRET_STATE.ABSENT) return config.metricaOauthToken || ''
  return ''
}

/**
 * Параметры строки запроса. Роутер отдаёт нормализованный путь без query
 * (см. normalizePath в server/app.js), поэтому разбираем req.url сами —
 * тем же способом, что и admin.leads.js.
 */
const queryOf = (req) => {
  const url = typeof req.url === 'string' ? req.url : ''
  const mark = url.indexOf('?')
  if (mark === -1) return new URLSearchParams()
  return new URLSearchParams(url.slice(mark + 1).split('#')[0])
}

export const registerAdminAnalyticsRoutes = (router, deps = {}) => {
  const { db } = deps
  if (!db) throw new TypeError('admin.analytics: нужен deps.db')

  const gateway = deps.metricaGateway || metricaGateway
  const getToken = deps.getToken || (() => resolveMetricaToken(db))

  router.register('GET', '/api/admin/analytics/summary', async (req, res) => {
    ensureRequestContext(req)
    const access = requireActive(db, req)
    if (!access.ok) return denyAsNotFound(req, res)
    if (!hasCapability(access.user, CAPABILITY.DASHBOARD_READ)) {
      return json(res, 403, { ok: false, error: 'forbidden' })
    }

    // Период приходит из адресной строки и уходит в запрос к Яндексу,
    // поэтому сверяется со списком, а не подставляется как есть.
    const requested = queryOf(req).get('period') || ''
    const period = Object.prototype.hasOwnProperty.call(PERIODS, requested)
      ? requested
      : DEFAULT_PERIOD

    const dashboard = await buildAnalyticsDashboard({
      db,
      gateway,
      token: getToken(),
      period,
    })

    // Неудача обращения к Яндексу — не ошибка нашего API: у ответа есть поле
    // error, и экран показывает по нему понятный текст вместе с теми цифрами,
    // которые всё-таки есть (последние удачные). Отдавать 502 значило бы
    // выкинуть кэш и оставить оператора с пустым экраном.
    return json(res, 200, { ok: true, dashboard })
  })
}
