import { useEffect, useRef } from 'react'
import useReducedMotion from '../../hooks/useReducedMotion'
import { attachAnimationLoop, throttleToFrame } from './animationLoop'

/**
 * Circulation-виджет в блоке контактов: холодные частицы-снежинки вращаются
 * в одну сторону, тёплые градиентные точки — в обратную.
 *
 * При «уменьшить движение» рисуется статичный кадр: без него виджет
 * превращался в пустой круг с логотипом.
 *
 * CR-054: виджет стоит в самом низу страницы, но кадры запрашивал с момента
 * монтирования. Теперь цикл идёт только когда холст во вьюпорте, а вкладка
 * на переднем плане.
 */
const CirculationCanvas = ({ count = 46 }) => {
  const canvasRef = useRef(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let parts = []

    const build = () => {
      // Тот же потолок DPR, что и у фонового снега: гуще 2× разницы не видно,
      // а пикселей на кадр становится кратно больше.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth || 320
      height = canvas.clientHeight || 320
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const base = Math.min(width, height) / 2
      parts = Array.from({ length: count }, (_, i) => {
        const cold = i % 2 === 0
        return {
          cold,
          ang: Math.random() * Math.PI * 2,
          rad: base * (0.62 + Math.random() * 0.3),
          spd: (cold ? 1 : -1) * (0.14 + Math.random() * 0.14),
          wob: 3 + Math.random() * 8,
          ph: Math.random() * Math.PI * 2,
          size: cold ? 2 + Math.random() * 2 : 2.5 + Math.random() * 3,
          a: 0.35 + Math.random() * 0.5,
        }
      })
    }

    const flake = (x, y, s, a) => {
      ctx.strokeStyle = `rgba(90,190,225,${a})`
      ctx.lineWidth = 1.1
      for (let k = 0; k < 3; k += 1) {
        const ang = (Math.PI / 3) * k
        ctx.beginPath()
        ctx.moveTo(x - Math.cos(ang) * s, y - Math.sin(ang) * s)
        ctx.lineTo(x + Math.cos(ang) * s, y + Math.sin(ang) * s)
        ctx.stroke()
      }
    }

    const paint = (t) => {
      ctx.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height / 2
      parts.forEach((p) => {
        const r = p.rad + Math.sin(t / 900 + p.ph) * p.wob
        const x = cx + Math.cos(p.ang) * r
        const y = cy + Math.sin(p.ang) * r * 0.94
        const pulse = 0.7 + 0.3 * Math.sin(t / 700 + p.ph)
        if (p.cold) {
          flake(x, y, p.size * 1.5 * pulse, p.a * pulse)
        } else {
          const g = ctx.createRadialGradient(x, y, 0, x, y, p.size * 3.2)
          g.addColorStop(0, `rgba(255,132,114,${p.a * pulse})`)
          g.addColorStop(1, 'rgba(255,132,114,0)')
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(x, y, p.size * 3.2, 0, Math.PI * 2)
          ctx.fill()
        }
      })
    }

    // Частицы крутятся всегда; при «уменьшить движение» — вдвое медленнее.
    const speed = reduced ? 0.5 : 1

    const step = (t) => {
      parts.forEach((p) => {
        p.ang += p.spd * 0.016 * speed
      })
      paint(t * speed)
    }

    build()
    // Пересборка частиц — самая дорогая операция виджета, и на каждое событие
    // resize её звать незачем: хватает одного раза на кадр.
    const onResize = throttleToFrame(build)
    window.addEventListener('resize', onResize, { passive: true })
    const attached = attachAnimationLoop({ element: canvas, onFrame: step })

    return () => {
      window.removeEventListener('resize', onResize)
      onResize.cancel()
      attached.dispose()
    }
  }, [count, reduced])

  return <canvas ref={canvasRef} aria-hidden="true" />
}

export default CirculationCanvas
