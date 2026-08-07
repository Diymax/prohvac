import { useEffect, useRef, useState } from 'react'
import useReducedMotion from '../hooks/useReducedMotion'

/**
 * Счётчик из макета: разгон с easeOutCubic за 1600 мс при попадании во вьюпорт.
 * При «уменьшить движение» конечное значение показывается сразу — число
 * не должно пропадать из вёрстки.
 */
const CountUpValue = ({ end, suffix = '+', duration = 1600 }) => {
  const ref = useRef(null)
  const reduced = useReducedMotion()
  const [value, setValue] = useState(() => (reduced ? end : 0))

  useEffect(() => {
    if (reduced) {
      setValue(end)
      return
    }

    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setValue(end)
      return
    }

    let raf = 0
    const run = () => {
      const start = performance.now()
      const tick = (now) => {
        const p = Math.min(1, (now - start) / duration)
        setValue(Math.round(end * (1 - (1 - p) ** 3)))
        if (p < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          run()
          observer.unobserve(entry.target)
        })
      },
      { threshold: 0.4 }
    )

    observer.observe(node)
    return () => {
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [end, duration, reduced])

  return (
    <strong ref={ref}>
      {value}
      {suffix}
    </strong>
  )
}

export default CountUpValue
