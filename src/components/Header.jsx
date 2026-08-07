import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import logo from '../assets/design/logo.webp'
import useScrollLock from '../hooks/useScrollLock'
import useModalA11y from '../hooks/useModalA11y'
// Переключатель языков живёт рядом с остальной языковой машинерией
// (src/language): его клавиатурное поведение — самостоятельный кусок логики,
// а не деталь шапки.
import LanguageSwitcher from '../language/LanguageSwitcher.jsx'
import { NAV_LINKS } from '../data/content'

const DRAWER_BACKGROUNDS = ['.pv-header', 'main', 'footer']

const Header = () => {
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef(null)
  const drawerTriggerRef = useRef(null)
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  // Общий счётчик блокировок: панель и модалка проекта могут быть открыты
  // одновременно, и наивное «сохранить/восстановить» оставляло страницу
  // заблокированной навсегда.
  useScrollLock(drawerOpen)

  useModalA11y({
    open: drawerOpen,
    containerRef: drawerRef,
    triggerRef: drawerTriggerRef,
    onClose: closeDrawer,
    backgroundSelectors: DRAWER_BACKGROUNDS,
  })

  return (
    <>
      <header className="pv-header">
        <div className="pv-header__bar">
          <a href="#top" className="pv-header__logo" aria-label="PROHVAC">
            {/* Размеры настоящие (640×360), а не «сколько занимает на экране»:
                высоту задаёт CSS, а из атрибутов браузер берёт пропорцию.
                Прежние 180×46 давали ей другое значение, и шапка дёргалась,
                поджимая логотип после загрузки. */}
            <img src={logo} alt="PROHVAC" width="640" height="360" />
          </a>

          <nav className="pv-nav" aria-label={t('nav.aria')}>
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="pv-nav__link">
                {t(link.key)}
              </a>
            ))}
            <LanguageSwitcher />
            <a href="#communication" className="pv-nav__cta">
              {t('nav.cta')}
            </a>
          </nav>

          <button
            ref={drawerTriggerRef}
            type="button"
            className="pv-burger"
            aria-label={t('nav.open')}
            aria-expanded={drawerOpen}
            aria-controls="pv-drawer"
            onClick={() => setDrawerOpen(true)}
          >
            <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
              <path d="M0 1h22M0 8h22M0 15h22" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </div>
      </header>

      {drawerOpen && (
        <div
          className="pv-drawer"
          onClick={closeDrawer}
          role="presentation"
        >
          <div
            id="pv-drawer"
            ref={drawerRef}
            className="pv-drawer__panel"
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.aria')}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="pv-drawer__head">
              <img
                src={logo}
                alt="PROHVAC"
                width="640"
                height="360"
                style={{ height: 38, width: 'auto' }}
              />
              <button
                type="button"
                className="pv-modal__close"
                aria-label={t('nav.close')}
                onClick={closeDrawer}
              >
                ×
              </button>
            </div>

            <ul className="pv-drawer__links">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  {/* Закрываем панель по клику: иначе она перекрывает секцию,
                      к которой только что проскроллили. */}
                  <a href={link.href} onClick={closeDrawer}>
                    {t(link.key)}
                  </a>
                </li>
              ))}
            </ul>

            <LanguageSwitcher variant="mobile" onPicked={closeDrawer} />

            <a
              href="#communication"
              className="pv-nav__cta"
              style={{ textAlign: 'center' }}
              onClick={closeDrawer}
            >
              {t('nav.cta')}
            </a>
          </div>
        </div>
      )}
    </>
  )
}

export default Header
