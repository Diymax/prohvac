import { useEffect } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Focus management shared by drawers, dialogs and the image lightbox.
 * Background selectors are explicit because dialogs are rendered in-place,
 * not through a portal; the hook never makes an ancestor of the dialog inert.
 */
const useModalA11y = ({
  open,
  containerRef,
  triggerRef,
  onClose,
  backgroundSelectors = [],
}) => {
  useEffect(() => {
    if (!open || !containerRef.current) return undefined
    const container = containerRef.current
    const trigger = triggerRef?.current || document.activeElement
    const backgrounds = []
    const seen = new Set()

    for (const selector of backgroundSelectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (node === container || node.contains(container) || container.contains(node)) continue
        if (seen.has(node)) continue
        seen.add(node)
        backgrounds.push({
          node,
          inert: node.hasAttribute('inert'),
          ariaHidden: node.getAttribute('aria-hidden'),
        })
        node.setAttribute('inert', '')
        node.setAttribute('aria-hidden', 'true')
      }
    }

    const focusFirst = () => {
      const first = container.querySelector(FOCUSABLE)
      const target = first || container
      target.focus({ preventScroll: true })
    }
    const frame = requestAnimationFrame(focusFirst)

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...container.querySelectorAll(FOCUSABLE)].filter(
        (node) => !node.hasAttribute('hidden') && node.getClientRects().length > 0
      )
      if (!focusable.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      for (const { node, inert, ariaHidden } of backgrounds) {
        if (!inert) node.removeAttribute('inert')
        if (ariaHidden == null) node.removeAttribute('aria-hidden')
        else node.setAttribute('aria-hidden', ariaHidden)
      }
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [backgroundSelectors, containerRef, onClose, open, triggerRef])
}

export default useModalA11y
