import { useTranslation } from 'react-i18next'
import logo from '../assets/design/logo.webp'
import useContent from '../content/useContent'
import { FOOTER_LINKS, formatPhone } from '../data/content'
import { METRICA_GOALS } from '../../shared/analytics.js'
import { reachGoal } from '../analytics/metrica.js'

const Footer = () => {
  const { t } = useTranslation()
  const { phones } = useContent()

  return (
    <footer className="pv-footer" role="contentinfo">
      {/* Единственное внешнее стекло принадлежит .pv-outro. Внутренние слои
          подвала прозрачны, поэтому контактные блоки и footer читаются одной
          непрерывной поверхностью без второй «карточки внутри карточки». */}
      <div className="pv-footer__top">
        <div className="pv-footer__grid">
          <div>
            {/* Ширину логотипа задаёт CSS (max-width 250px), высоту — пропорция
                из width/height: без них подвал подпрыгивал при загрузке. */}
            <img
              className="pv-footer__logo"
              src={logo}
              alt="PROHVAC"
              width="640"
              height="360"
              loading="lazy"
            />
            <p>{t('footer.about')}</p>
          </div>

          <div>
            <h3>{t('footer.h4')}</h3>
            <ul>
              {/* Список выведен из NAV_LINKS: собственный массив ссылок здесь
                  разъезжался с меню — раздел добавляли в шапку, а в подвале
                  его не было. */}
              {FOOTER_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{t(link.key)}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3>{t('footer.h42')}</h3>
            <ul>
              {phones.map((phone) => (
                <li key={phone}>
                  <a
                    href={`tel:${phone}`}
                    onClick={() => reachGoal(METRICA_GOALS.PHONE_CLICK, { place: 'footer' })}
                  >
                    {formatPhone(phone)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="pv-footer__bar">
        <div>
          <p>{t('footer.copyright')}</p>
          <p>{t('footer.city')}</p>
        </div>
      </div>
    </footer>
  )
}

export default Footer
