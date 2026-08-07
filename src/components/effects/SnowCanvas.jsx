import { useEffect, useRef } from 'react'
import useReducedMotion from '../../hooks/useReducedMotion'
import { attachAnimationLoop, throttleToFrame } from './animationLoop'

/**
 * Снежинки на фоне страницы (canvas поверх контента, pointer-events: none).
 * Параметры движения перенесены из макета.
 *
 * Частицы анимируются всегда: это мелкое низкоамплитудное оформление, ради
 * которого дизайн и делался. При системной настройке «уменьшить движение»
 * скорость снижается вдвое, а отключается только скролл-параллакс —
 * он и есть настоящий вестибулярный раздражитель.
 *
 * CR-054: кадры запрашиваются только у видимой страницы. Раньше свёрнутая
 * вкладка продолжала перерисовывать снег до самого закрытия.
 */
const SnowCanvas = ({ density = 20 }) => {
  const canvasRef = useRef(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let flakes = []

    const resize = () => {
      // Ограничение DPR: на телефоне с dpr 3 холст во весь экран стоил бы
      // вдвое больше пикселей на кадр, а разницы на полупрозрачных точках
      // радиусом 1–3 px не видно.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      flakes = Array.from({ length: density }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 1 + Math.random() * 2.4,
        vy: 0.25 + Math.random() * 0.75,
        drift: (Math.random() - 0.5) * 0.5,
        a: 0.25 + Math.random() * 0.45,
        ph: Math.random() * Math.PI * 2,
      }))
    }

    const paint = () => {
      ctx.clearRect(0, 0, width, height)
      flakes.forEach((f) => {
        ctx.beginPath()
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(120,196,232,${f.a})`
        ctx.fill()
      })
    }

    const speed = reduced ? 0.5 : 1

    const step = (t) => {
      flakes.forEach((f) => {
        f.y += f.vy * speed
        f.x += (f.drift + Math.sin(t / 1400 + f.ph) * 0.35) * speed
        if (f.y > height + 6) {
          f.y = -6
          f.x = Math.random() * width
        }
        if (f.x < -6) f.x = width + 6
        if (f.x > width + 6) f.x = -6
      })
      paint()
    }

    resize()
    // Один слушатель resize, схлопнутый до одного пересчёта на кадр: перетаскивание
    // угла окна давало десятки перестроений массива снежинок в секунду.
    const onResize = throttleToFrame(resize)
    window.addEventListener('resize', onResize, { passive: true })
    const attached = attachAnimationLoop({ element: canvas, onFrame: step })

    return () => {
      window.removeEventListener('resize', onResize)
      onResize.cancel()
      attached.dispose()
    }
  }, [density, reduced])

  return <canvas ref={canvasRef} className="pv-snow" aria-hidden="true" />
}

export default SnowCanvas
