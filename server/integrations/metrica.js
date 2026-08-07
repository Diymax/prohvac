// Шлюз к API Яндекс.Метрики. Единственное место, где проект ходит наружу
// за статистикой.
//
// Своя реализация на fetch, а не пакет из npm: официального SDK у Яндекса нет
// (API — чистый REST), а сторонние обёртки заброшены на версии 0.0.1
// несколько лет назад. Тянуть в зависимости мёртвый пакет ради трёх
// GET-запросов — это добавить себе поверхность атаки без единой выгоды.
//
// ТОКЕН НИКОГДА НЕ ПОПАДАЕТ В ЛОГ И В ОТВЕТ. Он уходит только в заголовок
// Authorization; текст ошибки от Яндекса перед возвратом чистится, потому что
// в теле ответа может оказаться эхо запроса.
//
// Ошибки классифицируются, а не пробрасываются as is: экран админки должен
// показать «токен протух» или «квота исчерпана» разными словами, а решение,
// что именно случилось, принимается здесь, где видны и статус, и тело.

const DEFAULT_API_BASE = 'https://api-metrika.yandex.net'
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Текст ошибки от Яндекса для показа оператору.
 *
 * Обрезается и чистится: в message бывает эхо параметров запроса, а параметры
 * приходят из адресной строки админки. Плюс страховка от токена, случайно
 * попавшего в текст, — если Яндекс когда-нибудь начнёт его возвращать.
 */
const safeMessage = (value) =>
  String(value ?? '')
    .replace(/OAuth\s+[A-Za-z0-9._-]+/gi, 'OAuth [redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200)

/**
 * HTTP-статус в машинный код ошибки.
 *
 * 401 и 403 разделены намеренно: первое — «токен протух или отозван»
 * (лечится заменой токена в настройках), второе — «у аккаунта нет доступа
 * к этому счётчику» (лечится выдачей гостевого доступа). Слить их в одно
 * значило бы заставить оператора угадывать, что чинить.
 */
const errorForStatus = (status) => {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'upstream_failed'
  return 'bad_request'
}

export const createMetricaGateway = ({
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  /**
   * Один GET к API.
   *
   * @returns {Promise<{ok: boolean, data?: object, error?: string,
   *                     status: number|null, message?: string}>}
   */
  const request = async (path, params, { token }) => {
    if (!token) return { ok: false, error: 'not_configured', status: null }

    const url = new URL(path, apiBase)
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          // Токен в заголовке, а не в query: query-строка оседает в логах
          // прокси и в истории, заголовок — нет.
          Authorization: `OAuth ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })

      const data = await response.json().catch(() => null)
      if (!response.ok) {
        return {
          ok: false,
          error: errorForStatus(response.status),
          status: response.status,
          message: safeMessage(data?.message || data?.errors?.[0]?.message),
        }
      }
      return { ok: true, data, status: response.status }
    } catch (error) {
      // AbortError — это наш таймаут, всё остальное сеть. Для вызывающего
      // разница невелика: данных нет, повторять можно.
      const timedOut = error?.name === 'AbortError'
      return {
        ok: false,
        error: timedOut ? 'timeout' : 'network',
        status: null,
        message: timedOut ? '' : safeMessage(error?.message),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * Табличный отчёт Stat API.
     *
     * accuracy=full обязателен: по умолчанию Яндекс может ответить по выборке,
     * и число визитов на дашборде тогда не сойдётся с интерфейсом Метрики.
     */
    stat: ({ token, counterId, metrics, dimensions, date1, date2, filters, sort, limit, attribution }) =>
      request(
        '/stat/v1/data',
        {
          ids: counterId,
          metrics,
          dimensions,
          date1,
          date2,
          filters,
          sort,
          limit,
          attribution,
          accuracy: 'full',
        },
        { token }
      ),

    /**
     * Список целей счётчика.
     *
     * Нужен, чтобы дашборд находил цели ПО ИМЕНИ (form_submit, phone_click),
     * а не по числовому id, вписанному в код. Иначе при пересоздании цели
     * в интерфейсе Метрики отчёт молча показывал бы нули по чужому id.
     */
    goals: ({ token, counterId }) =>
      request(`/management/v1/counter/${encodeURIComponent(counterId)}/goals`, {}, { token }),
  }
}

export const metricaGateway = createMetricaGateway()
