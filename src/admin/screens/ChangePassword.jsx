// Смена пароля.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. Маршрут POST /api/admin/password существовал с самого
// начала, а формы к нему не было ни одной: панель показывала предупреждение
// «пароль временный, смените его» и не давала ни одного способа это сделать.
// Единственным выходом был SSH и admin-cli, то есть человек с временным
// паролем оставался с ним навсегда.
//
// ПОЧЕМУ ЭКРАН ПЕРЕКРЫВАЕТ ПАНЕЛЬ. Пока mustChangePassword истинно, AdminApp
// показывает только его. Причина не в оформлении: временный пароль передают
// голосом или в мессенджере, а слабый — тот, который сервер отверг бы при
// смене, — подбирается. И то и другое означает, что учётной записью прямо
// сейчас может пользоваться не её владелец, и пускать такую сессию к заявкам
// с персональными данными до смены пароля незачем.
//
// ТРЕБОВАНИЯ ПОКАЗЫВАЮТСЯ СРАЗУ И ПРОВЕРЯЮТСЯ НА ЛЕТУ. Правила стойкости
// живут на сервере (server/auth/password.js) и там же остаются единственным
// авторитетом. Здесь они продублированы НАМЕРЕННО и только ради подсказки:
// без неё человек узнаёт про запрет клавиатурных последовательностей, отправив
// форму в третий раз. Расхождение безопасно в одну сторону — сервер строже.

import { useMemo, useState } from 'react'

const ERROR_TEXT = {
  invalid_credentials: 'Текущий пароль указан неверно',
  password_too_short: 'Пароль короче 12 символов',
  password_too_long: 'Пароль слишком длинный',
  password_equals_username: 'Пароль не может совпадать с логином',
  password_needs_mix: 'Нужны строчная буква, заглавная и цифра',
  password_repeat: 'Один и тот же символ подряд больше трёх раз',
  password_sequence: 'Пароль содержит ряд подряд идущих клавиш или букв',
  password_common: 'Такой пароль есть в словарях для подбора',
  password_unchanged: 'Новый пароль совпадает с текущим',
  rate_limited: 'Слишком много попыток. Подождите и попробуйте снова',
  invalid_payload: 'Форма отправлена в неожиданном виде',
  network: 'Нет связи с сервером',
  timeout: 'Сервер не ответил вовремя',
}

const errorText = (code) => (code ? ERROR_TEXT[code] || 'Не удалось сменить пароль' : '')

const MIN_LENGTH = 12

// Те же ряды, что в server/auth/password.js. Пять подряд — уже отказ.
const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'йцукенгшщзхъ',
  'фывапролджэ',
  'ячсмитьбю',
]

const hasSequence = (value) => {
  const text = value.toLowerCase()
  return SEQUENCES.some((row) => {
    const reversed = [...row].reverse().join('')
    for (let i = 0; i + 5 <= row.length; i += 1) {
      if (text.includes(row.slice(i, i + 5))) return true
      if (text.includes(reversed.slice(i, i + 5))) return true
    }
    return false
  })
}

/**
 * Список требований с отметкой выполнения. Пустое поле показывает их все
 * невыполненными, а не «ошибками»: до первого символа человек ничего не нарушил.
 */
const useChecklist = (password, username) => useMemo(() => [
  {
    id: 'length',
    text: `Не короче ${MIN_LENGTH} символов`,
    ok: [...password].length >= MIN_LENGTH,
  },
  {
    id: 'mix',
    text: 'Строчная буква, заглавная и цифра',
    ok: /\p{Ll}/u.test(password) && /\p{Lu}/u.test(password) && /\p{Nd}/u.test(password),
  },
  {
    id: 'repeat',
    text: 'Без четырёх одинаковых символов подряд',
    ok: password.length > 0 && !/(.)\1{3,}/u.test(password),
  },
  {
    id: 'sequence',
    text: 'Без рядов вида 12345 или qwert',
    ok: password.length > 0 && !hasSequence(password),
  },
  {
    id: 'username',
    text: 'Не повторяет логин',
    ok: password.length > 0 &&
      password.trim().toLowerCase() !== String(username ?? '').trim().toLowerCase(),
  },
], [password, username])

const ChangePassword = ({ session, onDone }) => {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [reveal, setReveal] = useState(false)
  const [done, setDone] = useState(false)
  const [revoked, setRevoked] = useState(0)

  const checklist = useChecklist(next, session.user?.username)
  const allOk = checklist.every((item) => item.ok)
  const matches = next.length > 0 && next === repeat
  const ready = current.length > 0 && allOk && matches && !session.busy

  const submit = async (event) => {
    event.preventDefault()
    if (!ready) return

    const result = await session.changePassword(current, next)
    // Значения убираем в любом случае: при удаче они больше не нужны,
    // при неудаче поле всё равно заполняется заново, а держать пароль
    // в памяти вкладки незачем.
    setCurrent('')
    setNext('')
    setRepeat('')
    if (!result?.ok) return

    setRevoked(Number(result.data?.revokedSessions) || 0)
    setDone(true)
  }

  if (done) {
    return (
      <section className="adm-panel">
        <header className="adm-panel__head">
          <h1 className="adm-panel__title">Пароль изменён</h1>
        </header>
        <p className="adm-text">
          Новый пароль сохранён.{' '}
          {revoked > 0
            ? `Остальные устройства разлогинены: ${revoked}.`
            : 'Других активных сессий не было.'}
        </p>
        <div className="adm-actions">
          <button className="adm-btn adm-btn--primary" type="button" onClick={onDone}>
            Продолжить работу
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="adm-panel">
      <header className="adm-panel__head">
        <h1 className="adm-panel__title">Смена пароля</h1>
        <p className="adm-panel__hint">
          {session.mustChangePassword
            ? 'Текущий пароль временный или не отвечает требованиям — задайте новый, чтобы продолжить.'
            : 'Смена пароля завершит сессии на всех остальных устройствах.'}
        </p>
      </header>

      <form className="adm-form" onSubmit={submit} noValidate>
        <label className="adm-field">
          <span className="adm-field__label">Текущий пароль</span>
          <input
            className="adm-input"
            type="password"
            name="current-password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            disabled={session.busy}
          />
        </label>

        <label className="adm-field">
          <span className="adm-field__label">Новый пароль</span>
          <input
            className="adm-input"
            type={reveal ? 'text' : 'password'}
            name="new-password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            disabled={session.busy}
            aria-describedby="password-rules"
          />
        </label>

        <label className="adm-field">
          <span className="adm-field__label">Ещё раз</span>
          <input
            className="adm-input"
            type={reveal ? 'text' : 'password'}
            name="confirm-password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            disabled={session.busy}
          />
          {repeat.length > 0 && !matches && (
            <span className="adm-field__error">Пароли не совпадают</span>
          )}
        </label>

        <label className="adm-check">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(event) => setReveal(event.target.checked)}
          />
          <span>Показать пароль</span>
        </label>

        <ul className="adm-rules" id="password-rules">
          {checklist.map((item) => (
            <li
              key={item.id}
              className={`adm-rules__item${item.ok ? ' adm-rules__item--ok' : ''}`}
            >
              <span className="adm-rules__mark" aria-hidden="true">{item.ok ? '✓' : '•'}</span>
              {item.text}
            </li>
          ))}
        </ul>

        {session.error && (
          <p className="adm-notice adm-notice--error" role="alert">
            {errorText(session.error)}
          </p>
        )}

        <div className="adm-actions">
          <button className="adm-btn adm-btn--primary" type="submit" disabled={!ready}>
            {session.busy ? 'Сохраняем…' : 'Сменить пароль'}
          </button>
          {/* Отказаться можно, только если смена добровольная: при временном
              пароле кнопка «позже» вернула бы человека ровно туда, откуда
              его сюда и отправили. */}
          {!session.mustChangePassword && (
            <button
              className="adm-btn adm-btn--ghost"
              type="button"
              onClick={onDone}
              disabled={session.busy}
            >
              Отмена
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

export default ChangePassword
