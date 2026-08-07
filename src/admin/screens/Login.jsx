// Вход в админку: пароль, затем второй фактор, а при потерянном телефоне —
// код восстановления.
//
// ОДИН ТЕКСТ ОШИБКИ НА ВСЕ ПРИЧИНЫ ОТКАЗА. Сервер отвечает одинаковым
// invalid_credentials и на несуществующий логин, и на неверный пароль,
// и на заблокированную учётку (см. шапку server/routes/admin.auth.js): иначе
// перебором логинов собирается список действующих учёток, а «аккаунт
// заблокирован» превращается в кнопку отказа в обслуживании для владельца
// сайта. Интерфейс обязан этот замысел сохранить, а не восстанавливать
// разницу догадками по времени ответа или по числу попыток. Поэтому здесь
// НЕТ и не должно появиться ни отдельного текста про блокировку, ни счётчика
// оставшихся попыток на шаге пароля.
//
// Счётчик попыток есть только на шаге второго фактора: там он не утечка —
// промежуточную сессию нужно ещё получить, предъявив верный пароль.

import { useEffect, useRef, useState } from 'react'

// Коды ошибок сервера → текст. Всё, чего в таблице нет, схлопывается
// в нейтральное сообщение: показывать пользователю сырой snake_case незачем.
const ERROR_TEXT = {
  invalid_credentials: 'Неверный логин или пароль',
  invalid_code: 'Код не подошёл',
  session_destroyed: 'Слишком много неудачных попыток. Начните вход заново',
  rate_limited: 'Слишком много попыток. Подождите и попробуйте снова',
  not_found: 'Вход не завершён — начните заново',
  // Ставится useSession, когда сессия пропала посреди работы: чаще всего это
  // истёкшее окно на привязку второго фактора.
  session_lost: 'Сессия истекла — войдите заново и продолжите с того же места',
  timeout: 'Сервер не ответил вовремя',
  network: 'Нет связи с сервером',
  unsupported_media_type: 'Браузер отправил запрос в неожиданном формате',
  payload_too_large: 'Слишком длинное значение',
}

const errorText = (code) => (code ? ERROR_TEXT[code] || 'Не удалось выполнить вход' : '')

/** Сообщение об ошибке. Пустое не рендерим совсем, чтобы не занимать место. */
const Notice = ({ code }) => {
  if (!code) return null
  return (
    <p className="adm-notice adm-notice--error" role="alert">
      {errorText(code)}
    </p>
  )
}

const PasswordForm = ({ busy, error, onSubmit }) => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const filled = username.trim().length > 0 && password.length > 0

  const submit = (event) => {
    event.preventDefault()
    if (busy || !filled) return
    onSubmit(username.trim(), password)
    // Пароль из состояния убираем сразу: при неудаче поле всё равно
    // заполняется заново, а лежать в памяти вкладки ему незачем.
    setPassword('')
  }

  return (
    <form className="adm-form" onSubmit={submit} noValidate>
      <h1 className="adm-auth__title">Вход в панель</h1>
      <p className="adm-auth__hint">Доступ только для сотрудников PROHVAC.</p>

      <label className="adm-field">
        <span className="adm-field__label">Логин</span>
        <input
          className="adm-input"
          type="text"
          name="username"
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck="false"
          autoFocus
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={busy}
        />
      </label>

      <label className="adm-field">
        <span className="adm-field__label">Пароль</span>
        <input
          className="adm-input"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
      </label>

      <Notice code={error} />

      <button className="adm-btn adm-btn--primary" type="submit" disabled={busy || !filled}>
        {busy ? 'Проверяем…' : 'Войти'}
      </button>
    </form>
  )
}

const SecondFactorForm = ({ busy, error, attemptsLeft, username, onTotp, onRecovery, onCancel }) => {
  // Режим переключается ссылкой «войти по recovery-коду»: форма одна,
  // а поле разное — шесть цифр против кода с бумаги.
  const [mode, setMode] = useState('totp')
  const [code, setCode] = useState('')
  const field = useRef(null)

  useEffect(() => {
    field.current?.focus()
  }, [mode])

  const recovery = mode === 'recovery'
  // Код из приложения — ровно шесть цифр, код восстановления — десять символов
  // с необязательным дефисом. Проверка нужна только чтобы не отправлять
  // заведомо неполный ввод: решает всё равно сервер.
  const ready = recovery ? code.replace(/[^0-9a-zA-Z]/g, '').length === 10 : code.length === 6

  const submit = (event) => {
    event.preventDefault()
    if (busy || !ready) return
    const action = recovery ? onRecovery : onTotp
    action(code)
    setCode('')
  }

  const switchMode = (next) => {
    setMode(next)
    setCode('')
  }

  return (
    <form className="adm-form" onSubmit={submit} noValidate>
      <h1 className="adm-auth__title">Подтверждение входа</h1>
      <p className="adm-auth__hint">
        {recovery
          ? 'Введите один из кодов восстановления, выданных при привязке приложения.'
          : 'Введите код из приложения-аутентификатора.'}
        {username ? ` Учётная запись: ${username}.` : ''}
      </p>

      <label className="adm-field">
        <span className="adm-field__label">{recovery ? 'Код восстановления' : 'Код из приложения'}</span>
        <input
          ref={field}
          className="adm-input adm-input--code"
          type="text"
          name={recovery ? 'recovery-code' : 'one-time-code'}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete={recovery ? 'off' : 'one-time-code'}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck="false"
          maxLength={recovery ? 11 : 6}
          placeholder={recovery ? 'XXXXX-XXXXX' : '000000'}
          value={code}
          onChange={(event) =>
            setCode(
              recovery
                ? event.target.value.toUpperCase()
                : event.target.value.replace(/\D/g, '')
            )
          }
          disabled={busy}
        />
      </label>

      <Notice code={error} />

      {attemptsLeft > 0 && (
        <p className="adm-notice">
          Осталось попыток: {attemptsLeft}. После последней вход начнётся заново с пароля.
        </p>
      )}

      <button className="adm-btn adm-btn--primary" type="submit" disabled={busy || !ready}>
        {busy ? 'Проверяем…' : 'Подтвердить'}
      </button>

      <div className="adm-auth__links">
        <button
          className="adm-link"
          type="button"
          onClick={() => switchMode(recovery ? 'totp' : 'recovery')}
          disabled={busy}
        >
          {recovery ? 'Ввести код из приложения' : 'Войти по recovery-коду'}
        </button>
        <button className="adm-link" type="button" onClick={onCancel} disabled={busy}>
          Начать заново
        </button>
      </div>
    </form>
  )
}

/**
 * Экран входа. Стадию задаёт сессия, а не собственное состояние компонента:
 * промежуточная сессия живёт на сервере, и после перезагрузки страницы
 * показывать шаг пароля, когда пароль уже принят, было бы неверно.
 */
const Login = ({ session }) => (
  <div className="adm-auth">
    <div className="adm-auth__card">
      <div className="adm-auth__brand">PROHVAC</div>

      {session.status === 'totp' ? (
        <SecondFactorForm
          busy={session.busy}
          error={session.error}
          attemptsLeft={session.attemptsLeft}
          username={session.user?.username || ''}
          onTotp={session.submitTotp}
          onRecovery={session.submitRecovery}
          onCancel={session.cancelPending}
        />
      ) : (
        <PasswordForm busy={session.busy} error={session.error} onSubmit={session.signIn} />
      )}
    </div>
  </div>
)

export default Login
