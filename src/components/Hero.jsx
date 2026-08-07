import { useTranslation } from 'react-i18next'
import heroImage from '../assets/design/hero-install.webp'
import useContent from '../content/useContent'

const Hero = () => {
  const { t } = useTranslation()
  const { heroFacts } = useContent()

  return (
    <section id="top" className="pv-hero">
      <div
        data-parallax
        className="pv-hero__media"
        style={{ backgroundImage: `url(${heroImage})` }}
        aria-hidden="true"
      />
      <div className="pv-hero__veil" aria-hidden="true" />

      <div className="pv-hero__inner">
        <div data-reveal className="pv-hero__card pv-glass pv-glass--strong">
          <p className="pv-hero__eyebrow">{t('hero.eyebrow')}</p>
          <h1 className="pv-hero__title">{t('hero.title')}</h1>
          <p className="pv-hero__lead">{t('hero.lead')}</p>
        </div>

        <div data-reveal className="pv-hero__actions">
          <a href="#projects" className="pv-btn pv-btn--primary">
            {t('hero.btnProjects')}
          </a>
          <a href="#communication" className="pv-btn pv-btn--ghost">
            {t('hero.btnContact')}
          </a>
        </div>

        {/* Цифры первого экрана — те же, что в блоке «В нашей компании»,
            отобранные по heroSlot. Собственного списка у Hero больше нет:
            он показывал свои значения и расходился с секцией цифр.
            Подпись короткая (hero.factN), при её отсутствии берётся длинная
            из блока цифр — иначе новый слот дал бы на экране голый ключ. */}
        {heroFacts.length > 0 && (
          <div data-reveal className="pv-hero__facts">
            {heroFacts.map((fact) => (
              <div key={fact.slug} className="pv-fact">
                <strong>
                  {fact.value}
                  {fact.suffix}
                </strong>
                <span>
                  {t(`hero.fact${fact.heroSlot}`, { defaultValue: t(`ratings.${fact.slug}`) })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export default Hero
