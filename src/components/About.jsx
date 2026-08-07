import { useTranslation } from 'react-i18next'
import useContent, { sizeAttrs } from '../content/useContent'

const About = () => {
  const { t } = useTranslation()
  const { gallery } = useContent()

  return (
    <section id="info" style={{ position: 'relative', overflow: 'hidden' }}>
      <div className="pv-about">
        <div data-reveal className="pv-about__card pv-glass">
          <h2>{t('about.h2')}</h2>
          <p>{t('about.p1')}</p>
          <p>{t('about.p2')}</p>
          <a href="#projects" className="pv-btn pv-btn--primary">
            {t('about.cta')}
          </a>
        </div>

        <div data-reveal className="pv-about__gallery">
          {gallery.map((photo) => (
            // altKey есть только у встроенных снимков: «Монтаж воздуховодов»
            // описывает конкретную фотографию, и подставлять эту подпись
            // произвольному файлу из админки — значит врать скринридеру.
            // Фотографии без подписи остаются оформлением: рядом стоит текст,
            // который несёт тот же смысл.
            <img
              key={photo.url}
              src={photo.url}
              alt={photo.altKey ? t(photo.altKey) : ''}
              loading="lazy"
              decoding="async"
              {...sizeAttrs(photo)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

export default About
