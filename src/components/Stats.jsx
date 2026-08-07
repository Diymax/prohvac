import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import statsImage from '../assets/design/stats-units.webp'
import CountUpValue from './CountUpValue'
import useContent from '../content/useContent'

// Запас до вьюпорта, на котором начинается загрузка фона: к моменту, когда
// секция реально показалась, картинка уже пришла.
const PRELOAD_MARGIN = '400px 0px'

const Stats = () => {
  const { t } = useTranslation()
  const { stats } = useContent()

  // CR-054: фон секции — 108 КБ декоративного снимка под плотной вуалью,
  // и лежит он ниже первого экрана. Инлайновый background-image браузер
  // забирает вместе с первой отрисовкой, то есть в самой узкой точке загрузки.
  // URL подставляется, только когда секция подходит к вьюпорту: тех же байтов
  // в стартовой пачке запросов больше нет.
  //
  // Без IntersectionObserver фон ставится сразу — деградация только в объёме
  // трафика, а не в вёрстке.
  const mediaRef = useRef(null)
  const [showMedia, setShowMedia] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    if (showMedia) return undefined
    const node = mediaRef.current
    if (!node) return undefined

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setShowMedia(true)
        observer.disconnect()
      },
      { rootMargin: PRELOAD_MARGIN }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [showMedia])

  // Якорь «О нас» ведёт сюда: секция с цифрами компании.
  // Раньше #info и #about указывали на один и тот же блок.
  return (
    <section id="about" className="pv-stats">
      <div
        ref={mediaRef}
        data-parallax-soft
        className="pv-stats__media"
        style={showMedia ? { backgroundImage: `url(${statsImage})` } : undefined}
        aria-hidden="true"
      />
      <div className="pv-stats__veil" aria-hidden="true" />

      <div className="pv-shell">
        <h2 data-reveal className="pv-h2 pv-h2--sm">
          {t('ratings.h2')}
        </h2>

        <div className="pv-stats__grid">
          {stats.map((stat) => (
            <div
              key={stat.slug}
              data-reveal
              className={`pv-stat pv-glass${stat.tone === 'warm' ? ' pv-stat--warm' : ''}`}
            >
              {/* Анимировать нечего, если цифра нечисловая ('ISO 9001'):
                  такое значение приходит целиком в суффиксе. */}
              {stat.value === null ? (
                <strong>{stat.suffix}</strong>
              ) : (
                <CountUpValue end={stat.value} suffix={stat.suffix} />
              )}
              <p>{t(`ratings.${stat.slug}`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Stats
