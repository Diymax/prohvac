// Выравнивание длительности ответа.
//
// Ветки авторизации стоят разное время: «пользователя нет» отвечает сразу,
// а «пароль неверный» — после проверки хеша (десятки миллисекунд). Разница
// измерима по сети и превращает форму входа в оракул для перебора логинов.
// Поэтому все ветки — и успешные, и отказные — доводятся до общего пола.

import { randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const toPositiveMs = (value) => {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** Асинхронная пауза; отрицательные и нечисловые значения дают 0. */
export const sleep = (ms) => delay(toPositiveMs(ms))

/**
 * Досыпает так, чтобы операция, начатая в startedAtMs, заняла не меньше floorMs,
 * и добавляет случайный джиттер 0..jitterMs.
 *
 * Джиттер обязателен: ровно постоянный пол сам по себе наблюдаем, а по краю
 * распределения (когда работа почти упирается в пол) атакующий всё ещё
 * различает ветки, усредняя тысячи замеров. Источник случайности — CSPRNG,
 * Math.random предсказуем и восстанавливается по нескольким выборкам.
 *
 * Возвращает фактически проспанные миллисекунды — удобно для тестов и логов.
 */
export const settleAt = async (startedAtMs, floorMs, jitterMs = 40) => {
  const floor = toPositiveMs(floorMs)
  const spread = Math.floor(toPositiveMs(jitterMs))

  // Если startedAtMs передали мусором, считаем, что не прошло ничего, и спим
  // весь пол целиком: ошибиться в сторону лишней задержки безопаснее, чем
  // молча отключить выравнивание на ветке, ради которой оно и делалось.
  const elapsed = Date.now() - Number(startedAtMs)
  const remaining = Math.max(0, floor - (Number.isFinite(elapsed) ? elapsed : 0))

  // randomInt(max) даёт [0, max), поэтому +1 — чтобы верхняя граница
  // джиттера была достижима.
  const jitter = spread > 0 ? randomInt(spread + 1) : 0

  // Джиттер добавляем всегда, даже если пол уже превышен: иначе «долгая»
  // ветка отличалась бы от «быстрой» отсутствием случайного хвоста.
  const waitMs = remaining + jitter
  if (waitMs > 0) await sleep(waitMs)
  return waitMs
}
