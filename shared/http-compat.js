// Хелперы ответа поверх обычного ServerResponse из node:http.
//
// Конвейер заявки (server/application/lead-pipeline.js) написан под сигнатуру
// (req, res) с цепочкой res.status(code).json(payload). Ни dev-сервер Vite,
// ни продовый роутер под Passenger таких методов не дают — там голый
// ServerResponse. Полифилл лежит в одном месте намеренно: пока он был
// скопирован в vite.config.js, dev и прод отвечали по-разному, и часть ошибок
// ловилась только после деплоя.
//
// CR-036: раньше хелперы назывались «Vercel-совместимыми» — от второго
// production-рантайма, который удалён вместе с api/ и vercel.json.

/**
 * Навешивает на ответ res.status(code) и res.json(payload).
 * Оба возвращают res, чтобы работала цепочка res.status(400).json({ ... }).
 *
 * Повторный вызов безопасен: роутер может обернуть ответ, который уже обёрнут
 * вышестоящим слоем (dev-плагин + сам обработчик).
 */
export const attachResponseHelpers = (res) => {
  if (typeof res.status === 'function' && typeof res.json === 'function') return res

  res.status = (code) => {
    res.statusCode = code
    return res
  }

  res.json = (payload) => {
    // Ответ мог быть уже отправлен — например, обработчик сначала вернул 504
    // по таймауту, а следом отработал catch. Второй end() бросил бы
    // ERR_STREAM_WRITE_AFTER_END и уронил бы весь процесс пула, а не запрос.
    if (res.writableEnded) return res

    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      // Ответы API персональные и короткоживущие: кэш прокси или браузера
      // может отдать чужой результат (например, статус админ-сессии).
      res.setHeader('Cache-Control', 'no-store')
    }

    res.end(JSON.stringify(payload))
    return res
  }

  return res
}
