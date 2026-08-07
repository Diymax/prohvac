import { useEffect } from 'react'
import useReducedMotion from './useReducedMotion'

/**
 * Параллакс фоновых слоёв героя и секции счётчиков.
 * Значения смещения взяты из макета: 0.05 для героя, 0.08 для «мягкого» слоя.
 * Обновление привязано к requestAnimationFrame, чтобы не считать layout
 * на каждом событии скролла.
 */
const useParallax = () => {
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced) {
      // Сбрасываем смещение, если настройку включили уже после загрузки.
      document.querySelectorAll('[data-parallax], [data-parallax-soft]').forEach((el) => {
        el.style.transform = ''
      })
      return
    }

    let frame = 0

    const apply = () => {
      frame = 0
      const y = window.scrollY || 0

      document.querySelectorAll('[data-parallax]').forEach((el) => {
        // scaleX(var(--pv-flip)) обязателен: inline-стиль перекрывает правило
        // из таблицы стилей целиком, и без этого множителя зеркалирование героя
        // в арабской локали не срабатывало ни разу — первый экран оставался
        // пустым, потому что смысловая часть иллюстрации уезжала под вуаль.
        // Значение переменной задаёт CSS ([dir='rtl'] .pv-hero__media),
        // поэтому смена языка подхватывается без перезапуска эффекта.
        el.style.transform = `translate3d(0, ${y * 0.05}px, 0) scaleX(var(--pv-flip, 1))`
      })

      document.querySelectorAll('[data-parallax-soft]').forEach((el) => {
        const rect = el.parentElement?.getBoundingClientRect()
        if (!rect) return
        el.style.transform = `translate3d(0, ${-rect.top * 0.08}px, 0) scale(1.05)`
      })
    }

    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(apply)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    apply()

    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [reduced])
}

export default useParallax
