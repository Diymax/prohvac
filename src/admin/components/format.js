// Общие мелочи админских экранов: расшифровка кодов ошибок, размеры и даты.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. Все пять экранов ловят одни и те же коды ошибок
// (сервер отвечает {ok:false, error:'invalid_slug'}) и показывают одни и те же
// размеры файлов. Пять копий словаря разошлись бы уже на второй правке, и один
// и тот же отказ выглядел бы в разных разделах по-разному.

// Узбекистан круглый год на UTC+5: переход на летнее время отменён в 1995-м.
// Смещение зашито числом, а не берётся из Intl, ровно по той же причине, что
// и на сервере (server/routes/admin.settings.js): дата в списке заявок обязана
// совпадать с датой в сообщении бота и в выгрузке CSV, а часовой пояс браузера
// менеджера к этому отношения не имеет.
import { frontendError } from '../../errors.js'

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000

const KB = 1024
const MB = 1024 * 1024

/**
 * Код ошибки из того, что бросил api.js.
 *
 * Штатный случай — ApiError с полем code (см. src/admin/api.js). Остальные
 * ветки нужны не для красоты: в обработчик может прилететь обычный Error из
 * самого экрана (например, проверка поля формы) или строка, и разбираться,
 * что именно пришло, каждому экрану по отдельности незачем.
 */
export const errorCode = (error) => {
  if (!error) return ''
  if (typeof error === 'string') return error

  return error.code || error.error || error.payload?.error || error.message || ''
}

/**
 * Уточнение от сервера. Для отказов Telegram это единственное, что подсказывает,
 * что чинить («chat not found», «can't parse entities»), а для настроек —
 * причина, по которой значение не подошло схеме.
 */
export const errorDetail = (error) => {
  if (!error || typeof error === 'string') return ''
  return (
    error.payload?.description ||
    error.payload?.reason ||
    error.description ||
    error.reason ||
    ''
  )
}

// Полный список кодов, которые вообще умеют отдавать серверные маршруты
// админки. Незнакомый код не прячем, а показываем как есть: новая ошибка
// сервера должна выглядеть непонятно, но заметно, а не превращаться
// в универсальное «что-то пошло не так», по которому нечего чинить.
const MESSAGES = {
  // Общее
  forbidden: 'Недостаточно прав для этого действия',
  invalid_csrf: 'Сессия устарела, обновите страницу',
  csrf_mismatch: 'Сессия устарела, обновите страницу',
  invalid_origin: 'Запрос пришёл с чужого адреса',
  unsupported_media_type: 'Неверный формат запроса',
  payload_too_large: 'Слишком большой объём данных',
  invalid_json: 'Некорректное тело запроса',
  rate_limited: 'Слишком часто, попробуйте позже',
  not_found: 'Запись не найдена',
  unknown_type: 'Неизвестный тип записи',
  content_unavailable: 'Контент временно недоступен',

  // Тексты
  invalid_key: 'Некорректный ключ',
  invalid_keys: 'Некорректный список ключей',
  invalid_lang: 'Неизвестный язык',
  invalid_langs: 'Неизвестные языки в списке',
  invalid_value: 'Некорректное значение',
  value_too_long: 'Значение слишком длинное',

  // Сущности
  invalid_slug: 'Slug: только строчная латиница, цифры и дефис, от 2 символов',
  slug_taken: 'Такой slug уже занят',
  slug_immutable: 'Slug изменить нельзя — заведите новую запись',
  key_taken: 'Такой ключ уже занят',
  key_immutable: 'Ключ изменить нельзя — заведите новую запись',
  invalid_name: 'Название обязательно и не длиннее 120 символов',
  invalid_url: 'Ссылка должна начинаться с https://',
  invalid_status: 'Недопустимый статус',
  invalid_tone: 'Недопустимая подача карточки',
  invalid_position: 'Недопустимая позиция',
  invalid_media_id: 'Некорректный ID файла',
  media_not_found: 'Файл с таким ID не найден',
  invalid_photos: 'Некорректный список фотографий',
  too_many_photos: 'Слишком много фотографий в галерее',
  duplicate_photo: 'Одна и та же фотография указана дважды',
  invalid_hero_slot: 'Слот первого экрана — число от 1 до 4',
  invalid_e164: 'Телефон в формате +998901234567',
  e164_taken: 'Такой телефон уже есть в списке',
  invalid_ids: 'Некорректный порядок элементов',
  unknown_id: 'В списке порядка есть несуществующая запись',

  // Медиа
  no_file: 'Файл не выбран',
  not_an_image: 'Это не изображение',
  unsupported_mime: 'Поддерживаются только JPEG, PNG и WebP',
  too_large: 'Файл слишком большой',
  dimensions_too_large: 'Слишком большие размеры изображения',
  quota_exceeded: 'Квота хранилища исчерпана — удалите лишние файлы',
  media_in_use: 'Файл используется на сайте',

  // Настройки
  unknown_key: 'Неизвестная настройка',
  not_configured: 'Бот не настроен: нужны токен и id чата',
  telegram_disabled: 'Отправка в Telegram выключена в настройках',
  telegram_error: 'Telegram отклонил сообщение',
  telegram_unreachable: 'Telegram недоступен',
  timeout: 'Telegram не ответил вовремя',

  // Заявки
  lead_not_found: 'Заявка не найдена',
  nothing_to_update: 'Нечего сохранять',
  invalid_note: 'Заметка слишком длинная или содержит недопустимые символы',
  invalid_pagination: 'Некорректные параметры страницы',
  invalid_from: 'Некорректная дата «с»',
  invalid_to: 'Некорректная дата «по»',
  already_sent: 'Заявка уже доставлена в Telegram',
}

/**
 * Человеческий текст ошибки. Уточнение от сервера (например, ответ Telegram)
 * дописывается в скобках: без него «Telegram отклонил сообщение» не подсказывает,
 * что именно чинить.
 */
export const errorText = (error, fallback = 'Не удалось выполнить запрос') => {
  const code = errorCode(error)
  if (!code) return fallback

  const detail = errorDetail(error)
  const model = frontendError(error, { fallback })
  const base = MESSAGES[code] ?? `${model.message} ${model.action}`
  return detail ? `${base} (${detail})` : base
}

export const errorDiagnostic = (error) => {
  const model = frontendError(error)
  return {
    technicalCode: model.technicalCode,
    requestId: model.requestId,
  }
}

/** Размер файла в удобных единицах. Точность падает с ростом числа. */
export const formatBytes = (bytes) => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < KB) return `${Math.round(value)} Б`
  if (value < MB) return `${(value / KB).toFixed(value < 10 * KB ? 1 : 0)} КБ`
  return `${(value / MB).toFixed(value < 10 * MB ? 2 : 1)} МБ`
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * Дата и время по Ташкенту в виде 'ДД.ММ.ГГГГ ЧЧ:ММ'.
 *
 * Через getUTC*: смещение прибавлено вручную, и локальная зона браузера не
 * должна прибавиться к нему второй раз.
 */
export const formatDateTime = (ms) => {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '—'

  const date = new Date(value + TASHKENT_OFFSET_MS)
  return (
    `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  )
}

/** Правильное окончание: 1 ключ, 2 ключа, 5 ключей. */
export const plural = (count, one, few, many) => {
  const n = Math.abs(Number(count) || 0) % 100
  const tail = n % 10
  if (n > 10 && n < 20) return many
  if (tail > 1 && tail < 5) return few
  if (tail === 1) return one
  return many
}
