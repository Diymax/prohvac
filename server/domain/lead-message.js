// The Telegram message built from a lead.
//
// Pure domain code: no database, no HTTP, no configuration. The template comes
// from the caller, which is what lets the same rendering serve the public form,
// the manual resend from the admin panel and the settings self-test - three
// call sites that must never produce three different-looking messages.

import { escapeMarkdownV2 } from '../../shared/lead.js'
import {
  DEFAULT_TELEGRAM_TEMPLATE,
  TELEGRAM_TEMPLATE_PLACEHOLDERS,
} from '../../shared/settings.js'

/**
 * Placeholders substituted into the template. The list is closed: an unknown
 * name in braces is a typo, and it has to surface when the template is saved
 * rather than as silence in the chat a week later.
 */
export const TEMPLATE_PLACEHOLDERS = TELEGRAM_TEMPLATE_PLACEHOLDERS

// The default repeats the message shape of shared/lead.js so that a lead resent
// from the admin panel looks exactly like one that arrived from the site.
export { DEFAULT_TELEGRAM_TEMPLATE }

const PLACEHOLDER_PATTERN = /\{([a-z_]{1,32})\}/g

// Uzbekistan stays on UTC+5 all year: daylight saving was abolished in 1995.
// Hence the fixed offset instead of Intl, which pulls in ICU that a trimmed
// Node build on the hosting may not have - the date would silently drift to UTC.
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000

/**
 * Time as 'YYYY-MM-DD HH:MM' in Tashkent.
 *
 * Shared with the CSV export of leads: two implementations of the same format
 * would inevitably drift, and one lead would look like it arrived at two
 * different times in the chat and in the spreadsheet.
 */
export const formatTimestamp = (ms) => {
  const value = Number(ms)
  if (!Number.isFinite(value)) return ''

  const date = new Date(value + TASHKENT_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  // getUTC* on purpose: the offset is already added by hand, and the server's
  // local zone must not be added to it a second time.
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  )
}

/**
 * Placeholder names used in a template that are not part of the closed list.
 * Used by settings validation, which is the only moment a typo can still be
 * reported to the person who made it.
 */
export const unknownPlaceholders = (template) =>
  [...String(template ?? '').matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1])
    .filter((name) => !TEMPLATE_PLACEHOLDERS.includes(name))

/**
 * Substitutes values into a MarkdownV2 template.
 *
 * IMPORTANT: only the substituted values are escaped, the template itself goes
 * to Telegram as is. Escaping the template would escape the very markup it
 * exists for (*bold*, `code`, dashes in prose) and the chat would show '\*Имя\*'
 * instead of a bold name. The trade-off is deliberate and known: whoever writes
 * the template escapes MarkdownV2 specials in their own text, and
 * POST /api/admin/settings/telegram-test lets them check the result safely.
 *
 * Values are always escaped: a name like 'Иван_*' arrives from an anonymous
 * visitor and, unescaped, breaks the message markup at best and forges extra
 * lines into it at worst.
 */
export const renderTemplate = (template, values) => {
  const source = typeof template === 'string' && template ? template : DEFAULT_TELEGRAM_TEMPLATE

  return source.replace(PLACEHOLDER_PATTERN, (match, name) => {
    if (!TEMPLATE_PLACEHOLDERS.includes(name)) return match
    const raw = values?.[name]
    // An empty value (a lead without a message) becomes a dash: the line
    // '💬 *Сообщение:*' with nothing after it reads as a truncated message.
    const text = raw == null || raw === '' ? '—' : String(raw)
    return escapeMarkdownV2(text)
  })
}

/** Message text for a lead. Shared by the intake, the resend and the self-test. */
export const renderLeadMessage = (template, lead) =>
  renderTemplate(template, {
    name: lead?.name ?? '',
    phone: lead?.phone ?? '',
    message: lead?.message ?? '',
    date: formatTimestamp(lead?.createdAt ?? Date.now()),
    lang: lead?.locale ?? 'ru',
  })
