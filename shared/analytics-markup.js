// Вырезание блоков Яндекс.Метрики из оболочки.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ФУНКЦИЯ В server/http/spa.js. Резать блоки
// нужно в двух местах: продовая оболочка делает это для админки, 404 и при
// выключенной аналитике, а dev-сервер Vite — вообще всегда. Импортировать
// spa.js в vite.config.js нельзя: он тянет за собой server/config.js, который
// читает окружение и умеет падать на старте, — Vite тогда не запустился бы
// с невнятной ошибкой ещё до первой строчки вывода.
//
// Модуль runtime-нейтрален: только регулярные выражения и строка на входе.

// Границы блоков — комментарии в index.html. Переименовывать их нельзя:
// на них держится и это вырезание, и сторожевой тест.
export const ANALYTICS_BLOCKS = Object.freeze([
  /[ \t]*<!-- Yandex\.Metrika counter -->[\s\S]*?<!-- End Yandex\.Metrika counter -->\r?\n?/,
  /[ \t]*<!-- Yandex\.Metrika counter \(noscript\) -->[\s\S]*?<!-- End Yandex\.Metrika counter \(noscript\) -->\r?\n?/,
])

/**
 * Убирает разметку аналитики из оболочки.
 *
 * @param {string} html Исходная оболочка.
 * @returns {string} Оболочка без блоков аналитики.
 */
export const stripAnalyticsMarkup = (html) =>
  ANALYTICS_BLOCKS.reduce((acc, pattern) => acc.replace(pattern, ''), html)
