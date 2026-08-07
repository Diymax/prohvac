// Привязка второго фактора: секрет текстом, QR-код и подтверждение первым
// кодом из приложения. В конце — коды восстановления, которые сервер
// показывает ровно один раз.
//
// ПРИВЯЗКА НЕ НАЧИНАЕТСЯ САМА. POST /api/admin/2fa/setup выдаёт новый секрет
// и запускает выпуск нового второго фактора — операцию, которая заканчивается
// заменой рабочего секрета, отзывом остальных сессий и новым комплектом кодов
// восстановления. Автозапуск на монтировании экрана означал бы, что случайный
// клик по пункту меню всё это затевает. Поэтому — только явная кнопка.
//
// СТАРЫЙ ФАКТОР ПРИ ЭТОМ РАБОТАЕТ. Новый секрет ждёт подтверждения в отдельной
// таблице (totp_pending, см. server/routes/admin.2fa.js), и подмена происходит
// одной транзакцией в момент confirm. Брошенная посреди привязка не оставляет
// аккаунт без второго фактора — это ровно то, что чинил CR-035.
//
// QR РИСУЕТСЯ САМ. Кодировщик в ../qr.js возвращает матрицу, а компонент
// разворачивает её в <svg> средствами React, то есть настоящими DOM-узлами.
// Ни dangerouslySetInnerHTML, ни canvas.toDataURL(): и то и другое потребовало
// бы ослабить CSP из server/http/spa.js ради картинки.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, setCsrfToken } from '../api.js'
import { encodeQr, qrCanvasSize, qrPath } from '../qr.js'

const ERROR_TEXT = {
  invalid_credentials: 'Неверный пароль',
  reauth_required: 'Подтвердите пароль ещё раз',
  bad_totp: 'Код не подошёл. Проверьте время на телефоне и попробуйте следующий',
  totp_already_enabled: 'Привязка уже подтверждена. Начните заново, если нужен новый секрет',
  totp_not_started: 'Секрет не выдан. Начните привязку заново',
  totp_setup_expired: 'Время на привязку истекло. Прежний код продолжает работать — начните заново',
  totp_swap_failed: 'Сервер не смог сохранить новую привязку. Прежний код продолжает работать',
  totp_secret_unreadable: 'Сервер не может прочитать секрет. Начните привязку заново',
  rate_limited: 'Слишком много попыток. Подождите и попробуйте снова',
  not_found: 'Сессия истекла — войдите заново',
  timeout: 'Сервер не ответил вовремя',
  network: 'Нет связи с сервером',
}

const errorText = (code) => (code ? ERROR_TEXT[code] || 'Не удалось выполнить операцию' : '')

// Секрет читают глазами и перепечатывают руками — группы по четыре символа
// заметно снижают шанс сбиться.
const groupSecret = (secret) => String(secret ?? '').replace(/(.{4})(?=.)/g, '$1 ')

/**
 * QR-код как inline-SVG.
 *
 * Один <path> вместо тысячи прямоугольников: строка попадает в атрибут d,
 * а не в разметку. shapeRendering="crispEdges" обязателен — со сглаживанием
 * между модулями появляются серые швы, и часть телефонов перестаёт читать код.
 */
const QrCode = ({ value }) => {
  const qr = useMemo(() => {
    try {
      return encodeQr(value)
    } catch (error) {
      // Ссылка не поместилась в поддерживаемые версии — не повод ронять экран:
      // секрет ниже всё равно показан текстом, его можно ввести руками.
      console.error('[admin] QR не построен:', error.message)
      return null
    }
  }, [value])

  if (!qr) {
    return <p className="adm-notice">QR-код построить не удалось — введите секрет вручную.</p>
  }

  const side = qrCanvasSize(qr.size)

  return (
    <svg
      className="adm-qr"
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label="QR-код для привязки приложения-аутентификатора"
      shapeRendering="crispEdges"
    >
      {/* Белая подложка внутри SVG: код должен читаться и на тёмной теме. */}
      <rect x="0" y="0" width={side} height={side} fill="#ffffff" />
      <path d={qrPath(qr)} fill="#000000" />
    </svg>
  )
}

const Setup2fa = ({ session, onDone }) => {
  const [stage, setStage] = useState('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [setup, setSetup] = useState(null)
  const [codes, setCodes] = useState([])
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState('')

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const startSetup = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      // Тело '{}' обязательно: CSRF-барьер требует Content-Type
      // application/json, а он ставится только при наличии тела.
      const data = await api.post('/2fa/setup', {})
      if (!alive.current) return
      setSetup(data)
      setCode('')
      setStage('secret')
    } catch (failure) {
      if (!alive.current) return
      // Подтверждение пароля живёт десять минут: сюда попадают и те, кто
      // открыл вкладку утром, и те, кто вошёл по коду восстановления.
      if (failure.code === 'reauth_required') {
        setStage('reauth')
        setError('')
      } else {
        setError(failure.code || 'network')
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const submitReauth = async (event) => {
    event.preventDefault()
    if (busy || !password) return

    setBusy(true)
    setError('')
    try {
      await api.post('/reauth', { password })
      if (!alive.current) return
      setPassword('')
      setBusy(false)
      await startSetup()
    } catch (failure) {
      if (!alive.current) return
      setError(failure.code || 'network')
      setBusy(false)
    }
  }

  const submitConfirm = async (event) => {
    event.preventDefault()
    if (busy || code.length !== 6) return

    setBusy(true)
    setError('')
    try {
      const data = await api.post('/2fa/confirm', { code })
      if (!alive.current) return
      setCodes(Array.isArray(data.recoveryCodes) ? data.recoveryCodes : [])
      setStage('codes')
      // Подтверждение ротирует сессию, а вместе с ней и CSRF-токен. Старый
      // после этого недействителен, поэтому без обновления любая следующая
      // мутация — включая перевыпуск кодов — отвечала бы 403.
      if (data.csrfToken) setCsrfToken(data.csrfToken)
      // ВНИМАНИЕ: session.refresh() здесь вызывать нельзя.
      //
      // После подтверждения сервер повышает сессию до полноценной, и обновление
      // состояния немедленно увело бы пользователя в панель — вместе с экраном,
      // на котором коды восстановления показываются ЕДИНСТВЕННЫЙ раз. Человек,
      // потерявший телефон, остался бы без запасного входа и не понял бы почему.
      // Обновляем сессию только когда он подтвердит, что коды сохранил.
    } catch (failure) {
      if (!alive.current) return
      setError(failure.code || 'network')
      setCode('')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  /** Копирование через буфер обмена. Без него код переписывают с экрана руками. */
  const copy = async (what, text) => {
    try {
      await navigator.clipboard.writeText(text)
      if (alive.current) setCopied(what)
    } catch {
      // Буфер недоступен (нет разрешения, не защищённый контекст) — молча
      // остаёмся на месте: текст на экране и так виден и выделяется мышью.
      if (alive.current) setCopied('')
    }
  }

  return (
    <section className="adm-panel">
      <header className="adm-panel__head">
        <h1 className="adm-panel__title">Двухфакторная аутентификация</h1>
        <p className="adm-panel__hint">
          Код из приложения — второй барьер после пароля. Без него украденный пароль
          не даёт войти.
        </p>
      </header>

      {error && (
        <p className="adm-notice adm-notice--error" role="alert">
          {errorText(error)}
        </p>
      )}

      {stage === 'idle' && (
        <div className="adm-stack">
          <p className="adm-text">
            Понадобится приложение-аутентификатор: Google Authenticator, Aegis, 1Password —
            любое, поддерживающее TOTP.
          </p>
          <p className="adm-text">
            Начало привязки выдаёт новый секрет. Если второй фактор уже настроен, прежний
            код продолжит работать до тех пор, пока вы не подтвердите новый.
          </p>
          <button className="adm-btn adm-btn--primary" type="button" onClick={startSetup} disabled={busy}>
            {busy ? 'Готовим…' : 'Начать привязку'}
          </button>
        </div>
      )}

      {stage === 'reauth' && (
        <form className="adm-form adm-form--inline" onSubmit={submitReauth} noValidate>
          <p className="adm-text">
            Операция меняет защиту учётной записи — подтвердите пароль.
          </p>
          <label className="adm-field">
            <span className="adm-field__label">Пароль</span>
            <input
              className="adm-input"
              type="password"
              name="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="adm-btn adm-btn--primary" type="submit" disabled={busy || !password}>
            {busy ? 'Проверяем…' : 'Подтвердить'}
          </button>
        </form>
      )}

      {stage === 'secret' && setup && (
        <div className="adm-2fa">
          <div className="adm-2fa__qr">
            <QrCode value={setup.uri} />
          </div>

          <div className="adm-2fa__body">
            {setup.rebind && (
              <p className="adm-notice">
                Прежний код действует до подтверждения. Как только новый код подойдёт,
                старая запись перестанет работать, остальные сессии будут завершены,
                а коды восстановления заменятся новыми.
              </p>
            )}

            <p className="adm-text">
              Отсканируйте код приложением. Если камера недоступна, добавьте запись вручную
              по секрету:
            </p>

            {/* Окно на привязку ограничено и не продлевается: и сам секрет
                (SETUP_TTL_MS в server/routes/admin.2fa.js), и сессия первичной
                привязки (ENROLL_TTL_MS в server/routes/admin.auth.js) живут
                двадцать минут. Сказать об этом обязательно: иначе истечение
                выглядит как самопроизвольный выброс на форму входа посреди
                установки приложения. */}
            <p className="adm-notice">
              На привязку есть 20 минут. Если не успеете — начните заново с этого же
              шага, ничего не потеряется.
            </p>

            <div className="adm-secret">
              <code className="adm-secret__value">{groupSecret(setup.secret)}</code>
              <button
                className="adm-btn adm-btn--ghost"
                type="button"
                onClick={() => copy('secret', setup.secret)}
              >
                {copied === 'secret' ? 'Скопировано' : 'Скопировать'}
              </button>
            </div>

            <dl className="adm-meta">
              <div>
                <dt>Алгоритм</dt>
                <dd>{setup.algorithm}</dd>
              </div>
              <div>
                <dt>Цифр в коде</dt>
                <dd>{setup.digits}</dd>
              </div>
              <div>
                <dt>Период</dt>
                <dd>{setup.period} с</dd>
              </div>
            </dl>

            <form className="adm-form adm-form--inline" onSubmit={submitConfirm} noValidate>
              <label className="adm-field">
                <span className="adm-field__label">Код из приложения</span>
                <input
                  className="adm-input adm-input--code"
                  type="text"
                  name="one-time-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  disabled={busy}
                />
              </label>
              <button
                className="adm-btn adm-btn--primary"
                type="submit"
                disabled={busy || code.length !== 6}
              >
                {busy ? 'Проверяем…' : 'Подтвердить привязку'}
              </button>
            </form>
          </div>
        </div>
      )}

      {stage === 'codes' && (
        <div className="adm-stack">
          <p className="adm-warning">
            Коды восстановления показываются один раз. Распечатайте или сохраните их
            в менеджере паролей: без телефона это единственный способ войти.
          </p>

          <ul className="adm-codes">
            {codes.map((item) => (
              <li key={item} className="adm-codes__item">
                {item}
              </li>
            ))}
          </ul>

          <div className="adm-row">
            <button
              className="adm-btn adm-btn--ghost"
              type="button"
              onClick={() => copy('codes', codes.join('\n'))}
            >
              {copied === 'codes' ? 'Скопировано' : 'Скопировать все'}
            </button>
            <button
              className="adm-btn adm-btn--primary"
              type="button"
              onClick={() => {
                setCodes([])
                setSetup(null)
                setStage('idle')
                // Только теперь обновляем сессию: пользователь подтвердил,
                // что коды сохранил, и уводить его с этого экрана можно.
                session.refresh()
                if (typeof onDone === 'function') onDone()
              }}
            >
              Я сохранил коды
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export default Setup2fa
