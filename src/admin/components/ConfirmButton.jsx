// Кнопка необратимого действия с подтверждением на месте.
//
// ПОЧЕМУ НЕ window.confirm. Системный диалог блокирует поток и в некоторых
// браузерах подавляется («не показывать больше диалоги этой страницы») — то
// есть удаление однажды пройдёт вообще без вопроса. Подтверждение внутри
// разметки этим свойством не обладает и заодно видно на скриншоте при разборе
// «кто удалил проект».

import { useEffect, useRef, useState } from 'react'

const ConfirmButton = ({
  onConfirm,
  children = 'Удалить',
  confirmLabel = 'Точно удалить',
  className = 'adm-btn adm-btn--danger',
  disabled = false,
  // Сколько ждать второго нажатия. Кнопка не может остаться «взведённой»
  // навсегда: через минуту человек уже не помнит, что и зачем нажимал.
  timeoutMs = 5000,
}) => {
  const [armed, setArmed] = useState(false)
  const timer = useRef(null)

  // Таймер живёт дольше компонента, если строку удалили сразу после нажатия,
  // и без снятия дёрнул бы setState на размонтированном компоненте.
  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    if (!armed) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        disarm()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [armed])

  const disarm = () => {
    clearTimeout(timer.current)
    setArmed(false)
  }

  const handleClick = () => {
    if (!armed) {
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), timeoutMs)
      return
    }
    disarm()
    onConfirm()
  }

  return (
    <span className="adm-confirm" aria-live="polite">
      <button
        type="button"
        className={armed ? 'adm-btn adm-btn--danger adm-btn--armed' : className}
        onClick={handleClick}
        disabled={disabled}
      >
        {armed ? confirmLabel : children}
      </button>
      {armed && (
        <button type="button" className="adm-btn adm-btn--ghost" onClick={disarm}>
          Отмена
        </button>
      )}
    </span>
  )
}

export default ConfirmButton
