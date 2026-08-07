// Защита имён и терминов от перевода.
//
// Без неё «PROHVAC», «Shivaki», «VRF» и «Mitsubishi Electric» приезжают
// в арабском транслитерацией, а в узбекском — переведёнными по смыслу.
// Глоссарии DeepL доступны не для всех пар (RU→TR и RU→AR среди них нет),
// поэтому механизм переносимый и работает на уровне текста: термины
// заменяются на плейсхолдеры до отправки и возвращаются после.
//
// Плейсхолдер выбран так, чтобы движок перевода не пытался его переводить
// и не переставлял: латиница вперемешку с цифрами без пробелов внутри.

const PLACEHOLDER = (index) => `PVTERM${index}X`

export const DEFAULT_TERMS = Object.freeze([
  'PROHVAC',
  'ProHVAC',
  'VRF',
  'VRV',
  'Shivaki',
  'AUX',
  'Toshiba',
  'Hisense',
  'Mitsubishi Electric',
  'AKFA Build',
  'AKFA',
  'KOC Construction',
  'KOC',
  'Discover Invest',
  'Ferroli',
  'CAEx',
  'ZAMIN HOTELS RAMADA',
  'HVAC',
])

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Сортировка по убыванию длины принципиальна: иначе «AKFA» подменится внутри
 * «AKFA Build», и до длинного термина дело уже не дойдёт.
 */
const sortByLength = (terms) => [...terms].sort((a, b) => b.length - a.length)

/**
 * Заменяет термины плейсхолдерами.
 * @returns {{text: string, map: Map<string, string>}}
 */
export const protectTerms = (text, terms = DEFAULT_TERMS) => {
  const source = String(text ?? '')
  if (!source) return { text: '', map: new Map() }

  const map = new Map()
  let result = source
  let index = 0

  for (const term of sortByLength(terms)) {
    if (!term) continue
    const pattern = new RegExp(escapeRegExp(term), 'g')
    if (!pattern.test(result)) continue

    const token = PLACEHOLDER(index)
    index += 1
    map.set(token, term)
    result = result.replace(new RegExp(escapeRegExp(term), 'g'), token)
  }

  return { text: result, map }
}

/**
 * Возвращает термины на место. Регистр плейсхолдера восстанавливаем
 * нечувствительно: некоторые движки приводят латиницу к нижнему регистру.
 */
export const restoreTerms = (text, map) => {
  let result = String(text ?? '')
  for (const [token, term] of map) {
    result = result.replace(new RegExp(escapeRegExp(token), 'gi'), term)
  }
  return result
}

/** Список терминов из настроек, с падением на значения по умолчанию. */
export const termsFromSetting = (stored) => {
  if (!Array.isArray(stored)) return DEFAULT_TERMS
  const clean = stored.filter((item) => typeof item === 'string' && item.trim())
  return clean.length ? clean : DEFAULT_TERMS
}
