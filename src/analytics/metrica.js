// Обёртка над глобальным ym() из сниппета Яндекс.Метрики.
//
// ПОЧЕМУ НЕ ЗВАТЬ ym() НАПРЯМУЮ. Счётчика на странице может не быть в четырёх
// штатных ситуациях, и все четыре — не ошибка:
//   1. ANALYTICS_ENABLED=0 — сервер вырезал сниппет из оболочки;
//   2. страница админки и любой 404 — там сниппета нет никогда;
//   3. блокировщик рекламы срезал mc.yandex.ru;
//   4. тесты и SSR-подобные окружения, где window вообще нет.
// Прямой вызов в каждом из них уронил бы обработчик формы — то есть заявку.
// Здесь всё сводится к «ничего не произошло».
//
// Ошибку в консоль тоже не пишем: посетителю с блокировщиком незачем видеть
// красный текст на каждый клик по телефону.

import { METRICA_COUNTER_ID } from '../../shared/analytics.js'

const counter = () => {
  if (typeof window === 'undefined') return null
  return typeof window.ym === 'function' ? window.ym : null
}

/**
 * Достижение цели. Имя брать из METRICA_GOALS, а не строкой по месту:
 * опечатка не вызовет ошибки, цель просто никогда не достигнется.
 */
export const reachGoal = (goal, params) => {
  const ym = counter()
  if (!ym) return false
  try {
    ym(METRICA_COUNTER_ID, 'reachGoal', goal, params)
    return true
  } catch {
    // Счётчик — не критичный путь: молчим, форма продолжает работать.
    return false
  }
}

/**
 * ClientID визита. Асинхронный по своей природе: сниппет мог ещё не успеть
 * загрузить tag.js, и тогда колбэк придёт позже — или не придёт вовсе.
 *
 * Промис РАЗРЕШАЕТСЯ значением null по таймауту, а не отклоняется: вызывающий
 * код (сборка полезной нагрузки заявки) не должен ветвиться на try/catch
 * из-за необязательного поля.
 */
export const getClientId = ({ timeoutMs = 1_000 } = {}) =>
  new Promise((resolve) => {
    const ym = counter()
    if (!ym) {
      resolve(null)
      return
    }

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(typeof value === 'string' && value ? value : null)
    }

    // Таймер обязателен: если счётчик не инициализировался, колбэк не будет
    // вызван никогда, и промис завис бы вместе с отправкой заявки.
    const timer = setTimeout(() => finish(null), timeoutMs)

    try {
      ym(METRICA_COUNTER_ID, 'getClientID', (clientId) => {
        clearTimeout(timer)
        finish(clientId)
      })
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
