// Каталог пользовательских ошибок фронтенда: машинный код сервера → понятная
// фраза и подсказка, что делать дальше.
//
// ЗАЧЕМ ЗДЕСЬ ЛОКАЛИЗАЦИЯ. Тексты ниже — значения по умолчанию (русские),
// а не единственный вариант: интерфейс лендинга существует на пяти языках,
// и «Нет связи с сервером» посреди арабской страницы читается как поломка.
// Переводы живут в public/locales/<lang>/translation.json под ключами
// errors.<код>.message и errors.<код>.action, а сюда приходит функция t
// из i18next (frontendError(error, { t })). Без t поведение прежнее —
// русские значения по умолчанию, — поэтому вызывающие, которым перевод
// не нужен (админка собирается без i18next), менять не пришлось.

const DEFINITIONS = Object.freeze({
  forbidden: {
    message: 'Недостаточно прав для этого действия.',
    action: 'Обратитесь к администратору с нужными полномочиями.',
  },
  unauthorized: {
    message: 'Нужно войти в систему.',
    action: 'Войдите снова и повторите действие.',
  },
  session_expired: {
    message: 'Сессия завершилась.',
    action: 'Войдите снова; несохранённые данные проверьте перед повтором.',
  },
  must_change_password: {
    message: 'Сначала необходимо сменить временный пароль.',
    action: 'Завершите смену пароля и повторите действие.',
  },
  csrf_failed: {
    message: 'Защитный токен сессии устарел.',
    action: 'Обновите страницу и повторите действие.',
  },
  rate_limited: {
    message: 'Слишком много запросов подряд.',
    action: 'Подождите указанное время перед повтором.',
  },
  validation_failed: {
    message: 'Некоторые данные заполнены неверно.',
    action: 'Проверьте отмеченные поля.',
  },
  not_configured: {
    message: 'Необходимая интеграция пока не настроена.',
    action: 'Используйте телефон для связи или проверьте настройки интеграции.',
  },
  telegram_failed: {
    message: 'Telegram не принял сообщение.',
    action: 'Проверьте состояние интеграции перед повтором.',
  },
  delivery_unknown: {
    message: 'Результат доставки пока неизвестен.',
    action: 'Не повторяйте отправку автоматически; сначала проверьте Telegram.',
  },
  payload_too_large: {
    message: 'Отправляемые данные слишком большие.',
    action: 'Уменьшите файл или текст и повторите.',
  },
  unsupported_media_type: {
    message: 'Этот формат данных не поддерживается.',
    action: 'Используйте один из форматов, указанных интерфейсом.',
  },
  media_rejected: {
    message: 'Файл не подошёл по формату или размеру.',
    action: 'Загрузите изображение JPEG, PNG или WebP допустимого размера.',
  },
  quota_exceeded: {
    message: 'Место в хранилище закончилось.',
    action: 'Удалите ненужные файлы и повторите загрузку.',
  },
  media_in_use: {
    message: 'Файл используется на сайте.',
    action: 'Сначала уберите его со страниц, а затем удалите.',
  },
  network_error: {
    message: 'Нет связи с сервером.',
    action: 'Проверьте подключение и повторите.',
  },
  server_error: {
    message: 'Сервер временно не может выполнить запрос.',
    action: 'Повторите позже; при обращении в поддержку укажите request ID.',
  },
})

const ALIASES = Object.freeze({
  no_session: 'session_expired',
  session_lost: 'session_expired',
  invalid_csrf: 'csrf_failed',
  csrf_mismatch: 'csrf_failed',
  invalid_origin: 'csrf_failed',
  origin_not_allowed: 'csrf_failed',
  invalid_payload: 'validation_failed',
  invalid_name: 'validation_failed',
  invalid_phone: 'validation_failed',
  invalid_message: 'validation_failed',
  network: 'network_error',
  ERR_NETWORK: 'network_error',
  ECONNABORTED: 'network_error',
  timeout: 'network_error',
  bad_response: 'server_error',
  internal_error: 'server_error',
  upload_failed: 'server_error',
  content_unavailable: 'server_error',
  telegram_error: 'telegram_failed',
  telegram_unreachable: 'telegram_failed',
  telegram_disabled: 'not_configured',
  // Медиа: сервер отвечает частными кодами загрузчика, но человеку важно одно —
  // файл не приняли и почему-то он не подходит.
  no_file: 'media_rejected',
  not_an_image: 'media_rejected',
  unsupported_mime: 'media_rejected',
  dimensions_too_large: 'media_rejected',
  too_large: 'payload_too_large',
  storage_full: 'quota_exceeded',
})

/** Значение по умолчанию, когда код неизвестен и вызывающий не дал своего. */
export const FRONTEND_FALLBACK_MESSAGE = 'Не удалось выполнить запрос.'

/** Пространство ключей перевода: errors.<код>.message / errors.<код>.action. */
export const ERROR_TRANSLATION_NAMESPACE = 'errors'

export const errorMessageKey = (code) => `${ERROR_TRANSLATION_NAMESPACE}.${code}.message`
export const errorActionKey = (code) => `${ERROR_TRANSLATION_NAMESPACE}.${code}.action`

/**
 * Перевод с гарантированным результатом.
 *
 * i18next при незагруженном бандле локали возвращает сам ключ, а при пустой
 * строке в файле — пустую строку. И то и другое на экране хуже, чем русский
 * текст по умолчанию, поэтому оба случая откатываются к defaultValue.
 */
const translate = (t, key, defaultValue) => {
  if (typeof t !== 'function') return defaultValue
  let value
  try {
    value = t(key, { defaultValue })
  } catch {
    return defaultValue
  }
  if (typeof value !== 'string') return defaultValue
  const trimmed = value.trim()
  if (!trimmed || trimmed === key) return defaultValue
  return value
}

export const frontendErrorCode = (error) => {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (!error.response && (error.code === 'ERR_NETWORK' || error.name === 'TypeError')) {
    return 'network_error'
  }
  return String(
    error.leadCode ||
      error.response?.data?.error ||
      error.payload?.error ||
      error.error ||
      error.code ||
      ''
  )
}

export const frontendRequestId = (error) =>
  String(
    error?.requestId ||
      error?.response?.headers?.['x-request-id'] ||
      error?.response?.data?.requestId ||
      error?.payload?.requestId ||
      ''
  )

/**
 * Модель ошибки для интерфейса.
 *
 * @param {unknown} error что бросил клиент API или axios
 * @param {{fallback?: string, t?: Function}} [options]
 *   fallback — свой текст на неизвестный код (у вызывающего он уже переведён);
 *   t — функция перевода i18next; без неё берутся русские значения.
 * @returns {{code: string, technicalCode: string, message: string,
 *   action: string, requestId: string}}
 */
export const frontendError = (error, options = {}) => {
  const { t } = options
  const technicalCode = frontendErrorCode(error)
  const code = ALIASES[technicalCode] || technicalCode
  const definition = DEFINITIONS[code]

  const customFallback = typeof options.fallback === 'string' && options.fallback ? options.fallback : ''
  const fallback = customFallback || translate(t, 'errors.fallback.message', FRONTEND_FALLBACK_MESSAGE)

  return Object.freeze({
    code: definition ? code : 'server_error',
    technicalCode: technicalCode || 'unknown_error',
    message: definition ? translate(t, errorMessageKey(code), definition.message) : fallback,
    action: translate(
      t,
      errorActionKey(definition ? code : 'server_error'),
      (definition || DEFINITIONS.server_error).action
    ),
    requestId: frontendRequestId(error),
  })
}

export const FRONTEND_ERROR_CODES = Object.freeze(Object.keys(DEFINITIONS))
