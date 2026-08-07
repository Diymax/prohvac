import { useTranslation } from 'react-i18next'
import useContent, { sizeAttrs } from '../content/useContent'

const Advantages = () => {
  const { t } = useTranslation()
  const { advantages } = useContent()

  return (
    <section id="services" className="pv-section">
      <div className="pv-shell">
        <h2 data-reveal className="pv-h2 pv-h2--center">
          {t('services.h2')}
        </h2>
        <p data-reveal className="pv-sub pv-sub--center">
          {t('services.sub')}
        </p>

        <div className="pv-grid-adv">
          {advantages.map((item) => (
            <div key={item.slug} data-reveal className="pv-adv pv-glass pv-lift">
              <div className={`pv-adv__icon${item.tone === 'warm' ? ' pv-adv__icon--warm' : ''}`}>
                {/* Иконку могли отвязать в админке — тогда остаётся пустая
                    плашка нужного размера, а не битая картинка. */}
                {item.icon && (
                  <img
                    src={item.icon.url}
                    alt=""
                    {...sizeAttrs(item.icon)}
                    loading="lazy"
                    decoding="async"
                  />
                )}
              </div>
              <div className="pv-adv__body">
                <h3>{t(`services.${item.slug}.title`)}</h3>
                <p>{t(`services.${item.slug}.desc`)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Advantages
