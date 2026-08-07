import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

const read = () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches

/**
 * Следит за системной настройкой «уменьшить движение» в рантайме.
 * Раньше значение читалось один раз при монтировании, поэтому переключение
 * настройки на лету рассогласовывало CSS (реагирует сразу) и JS (нет).
 */
const useReducedMotion = () => {
  const [reduced, setReduced] = useState(read)

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = (event) => setReduced(event.matches)
    mql.addEventListener('change', onChange)
    setReduced(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}

export default useReducedMotion
