import { useEffect } from 'react'

// Счётчик активных блокировок. Раньше каждый компонент сохранял «предыдущее»
// значение overflow и восстанавливал его в cleanup. Когда панель меню и модалка
// проекта были открыты одновременно, второй эффект захватывал уже изменённое
// 'hidden', и при закрытии в обратном порядке страница навсегда оставалась
// незакручиваемой.
let locks = 0

/**
 * Блокирует прокрутку body, пока active === true.
 * Безопасно при нескольких одновременно открытых оверлеях.
 */
const useScrollLock = (active) => {
  useEffect(() => {
    if (!active) return

    locks += 1
    if (locks === 1) {
      document.body.style.overflow = 'hidden'
    }

    return () => {
      locks -= 1
      if (locks <= 0) {
        locks = 0
        document.body.style.overflow = ''
      }
    }
  }, [active])
}

export default useScrollLock
