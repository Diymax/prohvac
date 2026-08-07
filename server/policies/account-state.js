// Единое прикладное состояние учётной записи.
//
// Оно намеренно ВЫВОДИТСЯ из уже существующих полей, а не хранится пятой
// колонкой: users.status, users.must_change_password и sessions.state меняются
// в разных транзакциях, и отдельный account_state неизбежно однажды разошёлся
// бы с ними.

export const ACCOUNT_STATE = Object.freeze({
  pendingPasswordChange: 'pending_password_change',
  pending2fa: 'pending_2fa',
  active: 'active',
  disabled: 'disabled',
})

/**
 * @param {{user?: object|null, session?: object|null}} value
 * @returns {'pending_password_change'|'pending_2fa'|'active'|'disabled'}
 */
export const accountStateOf = ({ user, session } = {}) => {
  if (!user || user.status !== 'active') return ACCOUNT_STATE.disabled
  if (session?.state === 'pending_totp') return ACCOUNT_STATE.pending2fa
  if (user.must_change_password === 1) return ACCOUNT_STATE.pendingPasswordChange
  if (session?.state === 'active') return ACCOUNT_STATE.active

  // Неизвестное состояние сессии не должно случайно получить права active.
  // CHECK базы не пропускает его штатно, но fail-closed важен для повреждённой
  // или подменённой тестовой реализации repository.
  return ACCOUNT_STATE.disabled
}
