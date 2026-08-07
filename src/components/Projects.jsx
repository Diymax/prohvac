import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import useScrollLock from '../hooks/useScrollLock'
import useModalA11y from '../hooks/useModalA11y'
import useContent, { sizeAttrs } from '../content/useContent'

const PROJECT_BACKGROUNDS = ['.pv-header', 'main > :not(#projects)', 'footer', '#projects > .pv-shell']
const LIGHTBOX_BACKGROUNDS = [
  '.pv-header',
  'main > :not(#projects)',
  'footer',
  '#projects > .pv-shell',
  '#projects .pv-modal',
]

const Projects = () => {
  const { t } = useTranslation()
  const { projects } = useContent()
  // Открытый проект помним по slug, а не по индексу: контент подменяется
  // ответом сервера уже после первого рендера, и индекс мог бы указать
  // на соседний проект или за конец списка.
  const [activeSlug, setActiveSlug] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const projectDialogRef = useRef(null)
  const projectTriggerRef = useRef(null)
  const lightboxDialogRef = useRef(null)
  const lightboxTriggerRef = useRef(null)

  const project = projects.find((item) => item.slug === activeSlug) ?? null

  const closeProject = useCallback(() => setActiveSlug(null), [])
  const closeLightbox = useCallback(() => setLightbox(null), [])

  useScrollLock(Boolean(project) || Boolean(lightbox))

  useModalA11y({
    open: Boolean(project) && !lightbox,
    containerRef: projectDialogRef,
    triggerRef: projectTriggerRef,
    onClose: closeProject,
    backgroundSelectors: PROJECT_BACKGROUNDS,
  })
  useModalA11y({
    open: Boolean(lightbox),
    containerRef: lightboxDialogRef,
    triggerRef: lightboxTriggerRef,
    onClose: closeLightbox,
    backgroundSelectors: LIGHTBOX_BACKGROUNDS,
  })

  return (
    <section id="projects" className="pv-section">
      <div className="pv-shell">
        <h2 data-reveal className="pv-h2">
          {t('projects.h2')}
        </h2>
        <p data-reveal className="pv-sub">
          {t('projects.sub')}
        </p>

        <div className="pv-grid-projects">
          {projects.map((item) => (
            <button
              key={item.slug}
              type="button"
              data-reveal
              className="pv-project pv-glass pv-lift"
              onClick={(event) => {
                projectTriggerRef.current = event.currentTarget
                setActiveSlug(item.slug)
              }}
            >
              {/* Размеры берутся из данных: у обложки, загруженной из админки,
                  пропорции произвольные, а фиксированную высоту карточки
                  задаёт CSS (.pv-project__img). */}
              {item.cover && (
                <img
                  className="pv-project__img"
                  src={item.cover.url}
                  alt={t(`projects.${item.slug}.title`)}
                  loading="lazy"
                  decoding="async"
                  {...sizeAttrs(item.cover)}
                />
              )}
              <span className="pv-project__body">
                <span className="pv-tag">{t(`projects.${item.slug}.tag`)}</span>
                <h3>{t(`projects.${item.slug}.title`)}</h3>
                <p>{t(`projects.${item.slug}.card`)}</p>
                <span className="pv-project__more">{t('projects.more')}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {project && (
        <div className="pv-overlay" role="presentation" onClick={closeProject}>
          <div
            ref={projectDialogRef}
            className="pv-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`project-dialog-${project.slug}`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="pv-modal__head">
              <div>
                <span className="pv-tag">{t(`projects.${project.slug}.tag`)}</span>
                <h3 id={`project-dialog-${project.slug}`}>{t(`projects.${project.slug}.title`)}</h3>
                <p>{t(`projects.${project.slug}.desc`)}</p>
              </div>
              <button
                type="button"
                className="pv-modal__close"
                aria-label={t('nav.close')}
                onClick={closeProject}
              >
                ×
              </button>
            </div>

            <div className="pv-modal__grid">
              {project.photos.map((photo, photoIndex) => (
                <button
                  key={photo.url}
                  type="button"
                  className="pv-photo"
                  aria-label={`${t(`projects.${project.slug}.title`)} — ${photoIndex + 1}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    lightboxTriggerRef.current = event.currentTarget
                    setLightbox(photo)
                  }}
                >
                  <img
                    src={photo.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    {...sizeAttrs(photo)}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div
          ref={lightboxDialogRef}
          className="pv-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${t('projects.h2')}: ${t('nav.close')}`}
          tabIndex={-1}
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="pv-modal__close pv-lightbox__close"
            aria-label={t('nav.close')}
            onClick={closeLightbox}
          >
            ×
          </button>
          <img
            src={lightbox.url}
            alt=""
            onClick={(event) => event.stopPropagation()}
            {...sizeAttrs(lightbox)}
          />
        </div>
      )}
    </section>
  )
}

export default Projects
