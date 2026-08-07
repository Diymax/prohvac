import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import useContent, { sizeAttrs } from '../content/useContent'

const Partners = () => {
  const { t } = useTranslation()
  const { partners } = useContent()

  // Лента прокручивается за счёт CSS-анимации на 50% ширины,
  // поэтому список дублируется — шов при зацикливании незаметен.
  // useMemo, а не константа модуля: список приезжает с сервера и меняется.
  const track = useMemo(() => [...partners, ...partners], [partners])

  return (
    <section id="enterprises" className="pv-section pv-section--marquee">
      {/* Заголовок в .pv-shell: у секции нет боковых отступов (лента идёт
          от края до края), и без обёртки текст упирался в границы экрана. */}
      <div className="pv-shell">
        <h2 data-reveal className="pv-h2 pv-h2--center pv-h2--sm">
          {t('enterprises')}
        </h2>
      </div>

      <div className="pv-marquee pv-glass">
        <div className="pv-marquee__mask">
          <div className="pv-marquee__track">
            {track.map((partner, index) => {
              // Вторая половина ленты — визуальный дубль, для скринридера скрыт.
              const duplicate = index >= partners.length
              const key = `${partner.slug}-${index}`

              // Логотипа может не быть: в media не принимаются SVG, а привязку
              // картинки в админке можно снять. Название текстом сохраняет
              // партнёра в ленте и не оставляет дыру шириной в логотип.
              if (!partner.logo) {
                return (
                  <span key={key} className="pv-marquee__name" aria-hidden={duplicate}>
                    {partner.name}
                  </span>
                )
              }

              return (
                <img
                  key={key}
                  src={partner.logo.url}
                  alt={duplicate ? '' : partner.name}
                  aria-hidden={duplicate}
                  loading="lazy"
                  decoding="async"
                  {...sizeAttrs(partner.logo)}
                />
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

export default Partners
