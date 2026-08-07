import { useEffect } from 'react'
import useReducedMotion from './useReducedMotion'

/**
 * Появление блоков при скролле: один IntersectionObserver на всё приложение.
 * Элементы помечаются атрибутом data-reveal, наблюдатель проставляет data-in="1".
 * Соседние элементы одного контейнера получают каскадную задержку, как в макете.
 *
 * MutationObserver добирает узлы, появившиеся после монтирования: без него
 * любой блок с data-reveal, отрисованный позже (условный рендер, динамический
 * список), навсегда оставался бы с opacity: 0.
 */
const useReveal = () => {
  const reduced = useReducedMotion()

  useEffect(() => {
    const showAll = () => {
      document
        .querySelectorAll('[data-reveal]:not([data-in])')
        .forEach((node) => node.setAttribute('data-in', '1'))
    }

    if (reduced || typeof IntersectionObserver === 'undefined') {
      showAll()
      // Узлы, добавленные позже, тоже нужно раскрыть.
      const mo = new MutationObserver(showAll)
      mo.observe(document.body, { childList: true, subtree: true })
      return () => mo.disconnect()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          const siblings = Array.from(entry.target.parentElement?.children ?? []).filter((child) =>
            child.hasAttribute('data-reveal')
          )
          const index = Math.max(0, siblings.indexOf(entry.target))
          entry.target.style.transitionDelay = `${Math.min(index * 90, 450)}ms`
          entry.target.setAttribute('data-in', '1')
          observer.unobserve(entry.target)
        })
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
    )

    const observeNew = () => {
      document
        .querySelectorAll('[data-reveal]:not([data-in])')
        .forEach((node) => observer.observe(node))
    }

    observeNew()
    const mo = new MutationObserver(observeNew)
    mo.observe(document.body, { childList: true, subtree: true })

    return () => {
      mo.disconnect()
      observer.disconnect()
    }
  }, [reduced])
}

export default useReveal
