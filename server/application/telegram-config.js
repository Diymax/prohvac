// Runtime Telegram configuration.
//
// The order is deliberate: a row in `settings` beats an environment variable.
// The variable is what was set at deployment time, the setting is what a person
// changed on purpose, and silently ignoring their change is not an option.
//
// TELEGRAM_API_BASE is never overridden by a setting: a substituted Bot API
// address means leads go into someone else's hands, and that decision stays
// with whoever has access to the hosting panel (see assertProductionConfig).

import { SECRET_STATE, SETTING_KEYS } from '../../shared/settings.js'
import { getSettingsService } from './settings-service.js'
import { config } from '../config.js'

/**
 * Telegram configuration as one immutable object.
 *
 * The plain values come from a single settings snapshot, so they always belong
 * to one revision of the table; the token is read separately because secrets
 * are never cached.
 *
 * The returned object CONTAINS THE BOT TOKEN. It may be handed to the code that
 * performs the outbound call, and must not be serialized into a response, a log
 * or an audit record.
 *
 * @param {object} db connection from server/db/index.js
 * @returns {Readonly<{botToken: string, chatId: string, template: string,
 *                     enabled: boolean, apiBase: string}>}
 */
export const resolveTelegramConfig = (db) => {
  const settings = getSettingsService(db)
  const stored = settings.readSecretState(SETTING_KEYS.TELEGRAM_BOT_TOKEN)

  // A corrupt record is an explicit but unusable override: falling back to the
  // deployment token would silently start sending leads to another bot.
  const botToken =
    stored.state === SECRET_STATE.COMPLETE
      ? stored.value
      : stored.state === SECRET_STATE.ABSENT
        ? config.telegramBotToken
        : ''

  const values = settings.snapshot().values

  return Object.freeze({
    botToken,
    chatId: values[SETTING_KEYS.TELEGRAM_CHAT_ID] || config.telegramChatId,
    template: values[SETTING_KEYS.TELEGRAM_TEMPLATE],
    enabled: values[SETTING_KEYS.TELEGRAM_ENABLED],
    apiBase: config.telegramApiBase,
  })
}
