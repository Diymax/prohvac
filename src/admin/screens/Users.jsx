// Раздел «Пользователи»: кто входит в панель и с какими правами.
//
// ПОЧЕМУ ЭКРАН ВООБЩЕ ПОЯВИЛСЯ. До него учётками управлял только
// scripts/admin-cli.mjs на сервере: отозвать доступ у уволенного означало
// открыть SSH к хостингу. Операция, которую делают в спешке и в неудобное
// время, не должна требовать консоли.
//
// ПОЧЕМУ СВОЮ УЧЁТКУ ЗДЕСЬ НЕ ТРОГАЮТ. Понизить себе роль, отключить или
// удалить себя — три способа выйти из панели без возможности вернуться.
// Сервер запрещает это независимо (self_target), здесь мы лишь не показываем
// заведомо недоступные кнопки: неактивная кнопка честнее ошибки после клика.
// Пароль и второй фактор себе меняют в разделе «Безопасность» — там для этого
// спрашивают текущий пароль.

import { useCallback, useEffect, useState } from 'react'

import { api } from '../api.js'
import ConfirmButton from '../components/ConfirmButton.jsx'
import Notice from '../components/Notice.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { errorCode, errorText, formatDateTime } from '../components/format.js'

const ROLES = [
  { id: 'owner', title: 'владелец', hint: 'Всё, включая этот раздел' },
  { id: 'admin', title: 'администратор', hint: 'Всё, кроме управления учётками' },
  { id: 'editor', title: 'редактор', hint: 'Тексты, медиа и заявки' },
  { id: 'viewer', title: 'наблюдатель', hint: 'Только просмотр' },
]

const ROLE_TITLE = Object.fromEntries(ROLES.map((role) => [role.id, role.title]))

const TWO_FACTOR = {
  on: { label: 'вход по коду', status: 'sent' },
  pending: { label: 'код не подтверждён', status: 'pending' },
  required: { label: 'код не подключён', status: 'stale' },
  off: { label: 'без второго фактора', status: 'failed' },
}

// Коды отказов сервера. Каждый объясняет причину, а не факт: «нельзя» без
// причины заставляет оператора гадать, что он сделал не так.
const ERROR_TEXT = {
  self_target: 'Свою учётную запись здесь изменить нельзя — для этого есть раздел «Безопасность».',
  last_owner: 'Это последний действующий владелец. Сначала назначьте владельцем кого-то ещё.',
  username_taken: 'Такой логин уже занят. Регистр не считается: Petrov и petrov — одна учётка.',
  invalid_username: 'Логин: от 3 до 32 символов, латиница, цифры, точка, дефис, подчёркивание.',
  unknown_role: 'Такой роли нет.',
  unknown_status: 'Такого состояния нет.',
  not_found: 'Учётная запись не найдена — возможно, её уже удалили.',
  forbidden: 'Управлять учётными записями может только владелец.',
  role_or_status: 'За один раз меняется что-то одно: либо роль, либо доступ.',
}

const describe = (error) => ERROR_TEXT[errorCode(error)] || errorText(error)

/** Временный пароль показывается один раз — второй возможности не будет. */
const Password = ({ issued, onHide }) => {
  const [copied, setCopied] = useState(false)
  if (!issued) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.password)
      setCopied(true)
    } catch {
      // Буфер обмена может быть недоступен (нет разрешения, не https).
      // Пароль виден на экране, и переписать его можно руками.
      setCopied(false)
    }
  }

  return (
    <Notice kind="success">
      <strong>Временный пароль для «{issued.username}»</strong>
      <code className="adm-users__password">{issued.password}</code>
      <span className="adm-muted">
        Показывается один раз: на сервере хранится только его хеш. Передайте лично — при первом
        входе панель потребует сменить пароль и подключить приложение-аутентификатор.
      </span>
      <span className="adm-users__password-actions">
        <button type="button" className="adm-btn" onClick={copy}>
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
        <button type="button" className="adm-btn adm-btn--ghost" onClick={onHide}>
          Скрыть
        </button>
      </span>
    </Notice>
  )
}

const Users = ({ session }) => {
  const [users, setUsers] = useState([])
  const [self, setSelf] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [issued, setIssued] = useState(null)
  const [username, setUsername] = useState('')
  const [role, setRole] = useState('viewer')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.get('/api/admin/users')
      setUsers(response.users)
      setSelf(response.self)
    } catch (nextError) {
      setError(nextError)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Одно место для всех действий: любое из них может вернуть отказ по правилу,
   * и обрабатывать его в шести обработчиках значило бы шесть раз ошибиться.
   * Ответ каждой изменяющей операции содержит свежий список — перезапрашивать
   * его отдельно незачем.
   */
  const act = async (key, run) => {
    setBusy(key)
    setError(null)
    try {
      const response = await run()
      if (response.users) setUsers(response.users)
      return response
    } catch (nextError) {
      setError(nextError)
      return null
    } finally {
      setBusy(null)
    }
  }

  const create = async (event) => {
    event.preventDefault()
    const response = await act('create', () =>
      api.post('/api/admin/users', { username: username.trim(), role })
    )
    if (!response) return
    setIssued({ username: response.user.username, password: response.password })
    setUsername('')
    setRole('viewer')
    await load()
  }

  const changeRole = (user, next) =>
    act(`role-${user.id}`, () => api.patch(`/api/admin/users/${user.id}`, { role: next }))

  const changeStatus = (user, next) =>
    act(`status-${user.id}`, () => api.patch(`/api/admin/users/${user.id}`, { status: next }))

  const resetPassword = async (user) => {
    const response = await act(`password-${user.id}`, () =>
      api.post(`/api/admin/users/${user.id}/reset-password`, {})
    )
    if (response) setIssued({ username: user.username, password: response.password })
  }

  const resetTwoFactor = (user) =>
    act(`totp-${user.id}`, () => api.post(`/api/admin/users/${user.id}/reset-2fa`, {}))

  const remove = (user) => act(`delete-${user.id}`, () => api.del(`/api/admin/users/${user.id}`))

  const owners = users.filter((user) => user.role === 'owner' && user.status === 'active').length

  return (
    <section className="adm-screen adm-screen--users" aria-busy={loading}>
      <header className="adm-screen__head">
        <div>
          <h1 className="adm-screen__title">Пользователи</h1>
          <p className="adm-muted">
            Кто входит в панель и с какими правами. Управлять учётками может только владелец;
            действующих владельцев сейчас {owners}.
          </p>
        </div>
        <button className="adm-btn" type="button" onClick={load} disabled={loading}>
          {loading ? 'Обновление…' : 'Обновить'}
        </button>
      </header>

      <Password issued={issued} onHide={() => setIssued(null)} />
      {error ? <Notice kind="error">{describe(error)}</Notice> : null}

      <form className="adm-card adm-card--form adm-users__new" onSubmit={create}>
        <h2 className="adm-card__title">Завести учётную запись</h2>
        <div className="adm-row">
          <label className="adm-field">
            <span className="adm-field__label">Логин</span>
            <input
              className="adm-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="ivanov"
              autoComplete="off"
              required
            />
          </label>
          <label className="adm-field">
            <span className="adm-field__label">Роль</span>
            <select
              className="adm-select"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {ROLES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} — {item.hint}
                </option>
              ))}
            </select>
          </label>
          <button
            className="adm-btn adm-btn--primary"
            type="submit"
            disabled={busy === 'create' || username.trim().length < 3}
          >
            {busy === 'create' ? 'Заводим…' : 'Завести'}
          </button>
        </div>
        <p className="adm-muted">
          Пароль придумывает сервер и показывает один раз. Второй фактор обязателен для всех:
          подключить его человек сможет только сам, при первом входе.
        </p>
      </form>

      <div className="adm-users">
        {users.map((user) => {
          const isSelf = user.id === self
          const twoFactor = TWO_FACTOR[user.twoFactor] || TWO_FACTOR.off
          const locked = busy !== null

          return (
            <article className="adm-card adm-user" key={user.id}>
              <header className="adm-user__head">
                <strong className="adm-user__name">{user.username}</strong>
                {isSelf ? <span className="adm-badge adm-badge--muted">это вы</span> : null}
                <StatusBadge
                  status={user.status}
                  label={user.status === 'active' ? 'доступ есть' : 'доступ закрыт'}
                />
                <StatusBadge status={twoFactor.status} label={twoFactor.label} />
                {user.mustChangePassword ? (
                  <StatusBadge status="pending" label="пароль временный" />
                ) : null}
              </header>

              <p className="adm-muted adm-user__meta">
                {ROLE_TITLE[user.role] || user.role} · вход{' '}
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'ни разу'} · заведён{' '}
                {formatDateTime(user.createdAt)} · открытых сессий {user.sessionsOpen}
                {user.recoveryLeft ? ` · кодов восстановления ${user.recoveryLeft}` : ''}
              </p>

              <div className="adm-user__controls">
                <label className="adm-field adm-field--inline">
                  <span className="adm-field__label">Роль</span>
                  <select
                    className="adm-select"
                    value={user.role}
                    disabled={isSelf || locked}
                    title={isSelf ? 'Свою роль изменить нельзя' : undefined}
                    onChange={(event) => changeRole(user, event.target.value)}
                  >
                    {ROLES.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="adm-btn"
                  disabled={isSelf || locked}
                  title={isSelf ? 'Себе доступ здесь не закрывают' : undefined}
                  onClick={() => changeStatus(user, user.status === 'active' ? 'disabled' : 'active')}
                >
                  {user.status === 'active' ? 'Закрыть доступ' : 'Вернуть доступ'}
                </button>

                <button
                  type="button"
                  className="adm-btn"
                  disabled={isSelf || locked}
                  title={isSelf ? 'Свой пароль меняют в разделе «Безопасность»' : undefined}
                  onClick={() => resetPassword(user)}
                >
                  Выдать новый пароль
                </button>

                <button
                  type="button"
                  className="adm-btn"
                  disabled={isSelf || locked}
                  title={
                    isSelf
                      ? 'Свой аутентификатор перепривязывают в разделе «Безопасность»'
                      : 'Понадобится, если человек потерял телефон'
                  }
                  onClick={() => resetTwoFactor(user)}
                >
                  Сбросить второй фактор
                </button>

                <ConfirmButton
                  disabled={isSelf || locked}
                  confirmLabel="Точно удалить"
                  onConfirm={() => remove(user)}
                >
                  Удалить
                </ConfirmButton>
              </div>
            </article>
          )
        })}
      </div>

      {!loading && !users.length ? (
        <Notice kind="warning">
          Ни одной учётной записи. Такого не бывает при живой сессии — обновите страницу.
        </Notice>
      ) : null}

      <p className="adm-muted">
        Закрытый доступ отзывает все открытые сессии сразу. Удаление уносит саму учётку, но
        оставляет её след в журнале действий: кто и что менял, видно и после увольнения.
        {session?.user?.username ? ` Вы вошли как ${session.user.username}.` : ''}
      </p>
    </section>
  )
}

export default Users
