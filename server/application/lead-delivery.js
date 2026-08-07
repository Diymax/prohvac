import { createLeadRepository } from '../repositories/leads.js'

const safeError = (result) =>
  `${result.error || 'telegram_failed'}${result.description ? `: ${result.description}` : ''}`.slice(
    0,
    200
  )

const duplicateResult = (attempt) => {
  if (attempt.state === 'sent') {
    return { ok: true, duplicate: true, state: 'sent', messageId: attempt.telegram_message_id }
  }
  if (attempt.state === 'failed') {
    return { ok: false, duplicate: true, state: 'failed', error: attempt.safe_error || 'telegram_failed' }
  }
  if (attempt.state === 'delivery_unknown') {
    return { ok: false, duplicate: true, state: 'delivery_unknown', error: 'delivery_unknown' }
  }
  return { ok: false, duplicate: true, state: attempt.state, error: 'delivery_in_progress' }
}

export const createLeadDeliveryService = ({ db, telegramGateway }) => {
  const repository = createLeadRepository(db)

  const deliverClaimed = async ({ attempt, telegram, text, replyMarkup = null }) => {
    const result = await telegramGateway.send({
      botToken: telegram.botToken,
      chatId: telegram.chatId,
      apiBase: telegram.apiBase,
      text,
      replyMarkup,
    })

    if (result.ok) {
      try {
        repository.finalize(attempt.id, {
          state: 'sent',
          responseCode: result.responseCode,
          messageId: result.messageId,
          // Чат сохраняется вместе с идентификатором сообщения: без него
          // кнопки под карточкой некому будет обновить, если chat_id в
          // настройках потом изменят.
          chatId: telegram.chatId,
        })
        return { ok: true, state: 'sent', messageId: result.messageId ?? null }
      } catch (error) {
        try {
          repository.finalize(attempt.id, {
            state: 'delivery_unknown',
            responseCode: result.responseCode,
            messageId: result.messageId,
            safeError: 'local_commit_failed_after_telegram_success',
          })
        } catch {
          // The durable row remains `sending`; reconciliation treats stale
          // sending as unknown. Never downgrade a confirmed external success.
        }
        return { ok: false, state: 'delivery_unknown', error: 'delivery_unknown', cause: error }
      }
    }

    const state = result.definitive ? 'failed' : 'delivery_unknown'
    repository.finalize(attempt.id, {
      state,
      responseCode: result.responseCode,
      safeError: safeError(result),
    })
    return { ok: false, state, error: state === 'delivery_unknown' ? 'delivery_unknown' : result.error }
  }

  const submit = async ({
    lead,
    context,
    metadata,
    idempotencyKey,
    telegram,
    text,
    // Клавиатура собирается вызывающим кодом: ей нужен id заявки, который
    // существует только после createPending(). Поэтому не значение, а функция.
    replyMarkupFor = null,
  }) => {
    const created = repository.createPending({
      lead,
      context,
      metadata,
      idempotencyKey,
    })
    if (!created.created) return duplicateResult(created.attempt)
    if (!repository.markSending(created.attempt.id)) {
      return { ok: false, state: 'sending', error: 'delivery_in_progress' }
    }
    return deliverClaimed({
      attempt: { ...created.attempt, state: 'sending' },
      telegram,
      text,
      replyMarkup: replyMarkupFor ? replyMarkupFor(created.leadId) : null,
    })
  }

  const retry = async ({
    leadId,
    idempotencyKey,
    actorUserId,
    force,
    confirmUnknown,
    telegram,
    textForLead,
    replyMarkupFor = null,
  }) => {
    const claimed = repository.claimRetry({
      leadId,
      idempotencyKey,
      actorUserId,
      force,
      confirmUnknown,
    })
    if (!claimed.ok) return claimed
    if (claimed.duplicate) return duplicateResult(claimed.attempt)
    return deliverClaimed({
      attempt: claimed.attempt,
      telegram,
      text: textForLead(claimed.lead),
      // Пересланная карточка получает кнопки в текущем состоянии заявки,
      // а не в том, в каком она была при первой отправке.
      replyMarkup: replyMarkupFor ? replyMarkupFor(claimed.lead) : null,
    })
  }

  return { submit, retry, repository }
}
