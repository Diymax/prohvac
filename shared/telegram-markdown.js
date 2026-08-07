// MarkdownV2 validator shared by the local Bot API stub and the settings form.
//
// WHY THIS EXISTS. Messages go out with parse_mode=MarkdownV2, and Telegram
// rejects the whole request with HTTP 400 "can't parse entities" when a single
// reserved character is left unescaped. Only the substituted values are escaped
// automatically (see server/domain/lead-message.js) - the template itself is
// raw by design, because that is where the markup lives. So the one place a
// broken message can be introduced is an operator editing the template, and the
// one place it used to surface was a lead that never arrived.
//
// The stub in scripts/mock-telegram.mjs used to answer ok:true to any payload,
// which meant a locally "successful" send proved nothing about production. This
// validator is what lets the stub fail the same way the real API does.
//
// It is intentionally a validator, not a renderer: it answers "would Telegram
// reject this?", nothing more.

/** Characters Telegram reserves in MarkdownV2 and requires to be escaped. */
export const MARKDOWN_V2_SPECIALS = '_*[]()~`>#+-=|{}.!\\'

/** Telegram's hard cap on a single message's text. */
export const TELEGRAM_TEXT_LIMIT = 4096

const isSpecial = (char) => MARKDOWN_V2_SPECIALS.includes(char)

/**
 * Position of the first construct Telegram would reject, or null.
 *
 * The scan mirrors the reference parser closely enough to catch every mistake a
 * human makes by hand: an unescaped reserved character, an entity that is never
 * closed, and a link whose parenthesised URL is missing.
 *
 * Inside `code` and ```pre``` spans only the backslash and the closing backtick
 * keep their meaning - that is the real rule, and treating those spans like
 * ordinary text would reject valid templates.
 *
 * @param {string} value message text as it would be sent
 * @returns {{offset: number, char: string, reason: string}|null}
 */
export const findMarkdownV2Error = (value) => {
  const text = String(value ?? '')
  // Entities are matched by delimiter, so a stack is enough: Telegram itself
  // refuses interleaved (as opposed to nested) entities.
  const open = []
  let i = 0

  const fail = (offset, char, reason) => ({ offset, char, reason })

  while (i < text.length) {
    const char = text[i]

    if (char === '\\') {
      const next = text[i + 1]
      if (next === undefined) {
        return fail(i, '\\', 'строка заканчивается одиночным «\\»')
      }
      if (!isSpecial(next)) {
        return fail(i + 1, next, `«\\${next}» — экранировать можно только служебные символы`)
      }
      i += 2
      continue
    }

    // Fenced block: everything up to the closing fence is literal.
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3)
      if (end === -1) return fail(i, '```', 'не закрыт блок кода ```')
      i = end + 3
      continue
    }

    // Inline code: literal too, but a backslash still escapes.
    if (char === '`') {
      let j = i + 1
      let closed = false
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '`') {
          closed = true
          break
        }
        j += 1
      }
      if (!closed) return fail(i, '`', 'не закрыт `код`')
      i = j + 1
      continue
    }

    // Link or custom emoji: [text](url) / ![text](url).
    if (char === '[' || (char === '!' && text[i + 1] === '[')) {
      const bracket = char === '!' ? i + 1 : i
      const close = text.indexOf(']', bracket + 1)
      if (close === -1) return fail(bracket, '[', 'не закрыта «[» ссылки')
      if (text[close + 1] !== '(') {
        return fail(close, ']', 'после «]» ссылки должен идти «(url)»')
      }
      const paren = text.indexOf(')', close + 2)
      if (paren === -1) return fail(close + 1, '(', 'не закрыт «(url)» ссылки')
      // The label is ordinary markup and is validated on its own.
      const label = findMarkdownV2Error(text.slice(bracket + 1, close))
      if (label) return fail(bracket + 1 + label.offset, label.char, label.reason)
      i = paren + 1
      continue
    }

    // Paired entity delimiters. Longest first: '__' is not two '_'.
    const delimiter = ['||', '__', '*', '_', '~'].find((d) => text.startsWith(d, i))
    if (delimiter) {
      if (open[open.length - 1] === delimiter) open.pop()
      else open.push(delimiter)
      i += delimiter.length
      continue
    }

    if (isSpecial(char)) {
      return fail(i, char, `символ «${char}» служебный и должен быть экранирован как «\\${char}»`)
    }

    i += 1
  }

  if (open.length) {
    const delimiter = open[open.length - 1]
    return fail(text.lastIndexOf(delimiter), delimiter, `не закрыто выделение «${delimiter}»`)
  }

  return null
}

/** True when Telegram would accept the text as MarkdownV2. */
export const isValidMarkdownV2 = (value) => findMarkdownV2Error(value) === null

/**
 * Strips MarkdownV2 markup down to the text a human reads.
 *
 * Used as the fallback when Telegram rejects the markup: a lead that arrives
 * as plain text is worth incomparably more than one that never arrives.
 */
export const stripMarkdownV2 = (value) => {
  const text = String(value ?? '')
  let out = ''
  let i = 0

  while (i < text.length) {
    const char = text[i]
    if (char === '\\' && isSpecial(text[i + 1])) {
      out += text[i + 1]
      i += 2
      continue
    }
    if (text.startsWith('```', i)) {
      i += 3
      continue
    }
    const delimiter = ['||', '__', '*', '_', '~', '`'].find((d) => text.startsWith(d, i))
    if (delimiter) {
      i += delimiter.length
      continue
    }
    out += char
    i += 1
  }

  return out
}
