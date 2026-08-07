// Сбор атрибуции визита: откуда посетитель пришёл на лендинг.
//
// FIRST-TOUCH, А НЕ LAST-TOUCH. Заявку оставляют не с первого захода: человек
// приходит по объявлению, уходит думать, возвращается через поиск по названию
// компании и только тогда заполняет форму. Last-touch записал бы такую заявку
// на органику, и платный канал выглядел бы бесполезным ровно в тот момент,
// когда он сработал. Поэтому метки первого захода сохраняются и НЕ
// перезаписываются последующими.
//
// Referrer при этом берётся тоже первый: он часть той же картины «как нас
// нашли в первый раз».
//
// ХРАНИЛИЩЕ — localStorage. sessionStorage умирает вместе с вкладкой, то есть
// не переживает ровно тот сценарий, ради которого first-touch и заводится.
// Доступ к хранилищу может быть запрещён политикой браузера и бросает ещё
// до чтения — все обращения обёрнуты, недоступное хранилище означает работу
// без атрибуции, а не сломанную форму.

import { ATTRIBUTION_KEYS, normalizeLeadAttribution } from '../../shared/lead.js'
import { getClientId } from './metrica.js'

const STORAGE_KEY = 'prohvac.attribution.first'

/** Параметр URL -> ключ атрибуции. */
const URL_PARAMS = Object.freeze({
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
  yclid: 'yclid',
  gclid: 'gclid',
})

const storage = () => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const readStored = () => {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // Битая или недоступная запись означает ровно «атрибуции нет».
    return null
  }
}

/** Метки и реферер текущего захода. Пусто, если ни того, ни другого нет. */
const readCurrent = () => {
  if (typeof window === 'undefined') return {}

  const params = new URLSearchParams(window.location.search)
  const collected = {}
  for (const [param, key] of Object.entries(URL_PARAMS)) {
    const value = params.get(param)
    if (value) collected[key] = value
  }

  // Свой же домен реферером не считаем: это переход внутри сайта, а не
  // источник. Битый referrer (бывает у некоторых клиентов) просто игнорируем.
  try {
    const referrer = document.referrer
    if (referrer && new URL(referrer).host !== window.location.host) {
      collected.referrer = referrer
    }
  } catch {
    // Нечего добавить — оставляем как есть.
  }

  return collected
}

const hasAnything = (value) => ATTRIBUTION_KEYS.some((key) => value?.[key])

/**
 * Запоминает first-touch, если он ещё не записан. Вызывать один раз при
 * загрузке приложения.
 *
 * Пустой заход (прямой вход без меток и без реферера) НЕ записывается:
 * иначе первый же прямой визит навсегда зафиксировал бы пустую атрибуцию
 * и перекрыл настоящий источник, пришедший следующим переходом.
 */
export const captureFirstTouch = () => {
  const store = storage()
  if (!store) return
  if (readStored()) return

  const current = normalizeLeadAttribution(readCurrent())
  if (!hasAnything(current)) return

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Квота или запрет записи: заявка уйдёт без атрибуции, это допустимо.
  }
}

/**
 * Блок атрибуции для отправки вместе с заявкой.
 *
 * ClientID берётся здесь, а не при загрузке страницы: к моменту отправки
 * формы счётчик уже наверняка инициализирован, а на старте он мог ещё
 * грузиться. Значение необязательное — если счётчика нет, будет null.
 */
export const collectAttribution = async () => {
  const stored = readStored()
  // Если first-touch пуст (прямой заход), берём метки текущего захода —
  // они всё равно точнее, чем ничего.
  const base = hasAnything(stored) ? stored : readCurrent()
  const ymClientId = await getClientId()

  return normalizeLeadAttribution({ ...base, ymClientId })
}
