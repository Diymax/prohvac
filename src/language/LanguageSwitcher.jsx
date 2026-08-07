// Language selector.
//
// PATTERN: ARIA menu button with menuitemradio items, not a listbox.
// Picking a language performs an action (it loads a locale bundle and
// re-renders the page) instead of editing a value that is submitted later,
// which is what the menu pattern is for; a listbox would additionally require
// a focusable container with aria-activedescendant. The previous markup
// declared listbox/option roles with no keyboard handling at all, so screen
// reader users were told about a listbox that ignored Arrow keys (CR-053).
//
// Keyboard: Arrow Down/Up with wrapping, Home/End, first-letter type-ahead,
// Escape closes and returns focus to the trigger, Tab closes and moves on,
// Enter/Space activate the focused item natively. Focus is roving — the
// active item is the only one with tabindex 0 and it is focused for real,
// so the browser's own focus ring (see :focus-visible in index.css) shows
// the current item without any extra styling.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LANGUAGES } from '../data/content'
import { useLocalizedText } from '../hooks/useLocalizedText.js'
import { initialMenuIndex, menuKeyAction, triggerKeyAction } from './menuNavigation.js'

const TEXT = {
  'lang.label': 'Язык интерфейса',
  'lang.current': 'Язык интерфейса: {{lang}}',
  'lang.switching': 'Переключаем язык…',
}

const LABELS = LANGUAGES.map((language) => language.label)

const LanguageSwitcher = ({ variant = 'desktop', onPicked }) => {
  const { i18n } = useTranslation()
  const text = useLocalizedText(TEXT)

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [pending, setPending] = useState(null)

  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  const itemsRef = useRef([])
  const menuId = useId()

  // Номер последнего запроса: при быстрых переключениях побеждал язык, чей
  // JSON пришёл последним, а не тот, который выбрали последним.
  const requestRef = useRef(0)

  const current = (i18n.resolvedLanguage || i18n.language || 'ru').slice(0, 2)
  const currentIndex = LANGUAGES.findIndex((language) => language.code === current)
  const currentLabel = currentIndex >= 0 ? LANGUAGES[currentIndex].label : current.toUpperCase()

  const close = useCallback((restoreFocus) => {
    setOpen(false)
    setActiveIndex(-1)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  const pick = useCallback(
    (code) => {
      // Пока грузится локаль, новый выбор не принимаем: порядок ответов сети
      // иначе решает, какой язык победит.
      if (pending !== null) return
      close(true)
      onPicked?.()
      if (code === current) return

      const request = requestRef.current + 1
      requestRef.current = request
      setPending(code)

      // changeLanguage возвращает промис (подгрузка JSON локали) — ошибку нужно
      // обработать, иначе получим unhandled rejection при обрыве сети.
      i18n
        .changeLanguage(code)
        .catch((error) => {
          console.error('Не удалось переключить язык:', error?.message || error)
        })
        .finally(() => {
          // Устаревший ответ игнорируем: актуален только последний выбор.
          if (requestRef.current === request) setPending(null)
        })
    },
    [close, current, i18n, onPicked, pending]
  )

  // Клик мимо меню закрывает его, но фокус не возвращает: указатель уже
  // работает в другом месте страницы.
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [close, open])

  // Фокус переносится на активный пункт (roving tabindex). Без реального
  // focus() клавиатурный пользователь не видит, где он находится, а Escape
  // некуда возвращать.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    itemsRef.current[activeIndex]?.focus()
  }, [activeIndex, open])

  const onTriggerKeyDown = (event) => {
    const action = triggerKeyAction(event.key)
    if (action.type !== 'open') return
    event.preventDefault()
    setOpen(true)
    setActiveIndex(initialMenuIndex(action.focus, currentIndex, LANGUAGES.length))
  }

  const onMenuKeyDown = (event) => {
    const action = menuKeyAction(event.key, { index: activeIndex, labels: LABELS })
    if (action.handled) event.preventDefault()
    if (action.type === 'move') setActiveIndex(action.index)
    else if (action.type === 'close') close(action.restoreFocus === true)
  }

  if (variant === 'mobile') {
    // В выдвижной панели меню не нужно: список и так открыт, а Tab обходит
    // кнопки по порядку. aria-disabled вместо disabled — отключённая кнопка
    // теряет фокус в момент нажатия, и клавиатурный пользователь остаётся
    // ни на чём.
    return (
      <div className="pv-drawer__langs" role="group" aria-label={text('lang.label')}>
        {LANGUAGES.map((language) => (
          <button
            key={language.code}
            type="button"
            className="pv-lang__option"
            lang={language.code}
            aria-current={language.code === current}
            aria-disabled={pending !== null}
            onClick={() => pick(language.code)}
          >
            {language.code.toUpperCase()}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="pv-lang" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="pv-lang__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={text('lang.current', { lang: currentLabel })}
        aria-busy={pending !== null}
        onKeyDown={onTriggerKeyDown}
        onClick={() => {
          if (open) close(false)
          else {
            setOpen(true)
            setActiveIndex(initialMenuIndex('checked', currentIndex, LANGUAGES.length))
          }
        }}
      >
        {current}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul
          id={menuId}
          className="pv-lang__list pv-glass"
          role="menu"
          aria-label={text('lang.label')}
          onKeyDown={onMenuKeyDown}
        >
          {LANGUAGES.map((language, index) => (
            <li key={language.code} role="none">
              <button
                ref={(node) => {
                  itemsRef.current[index] = node
                }}
                type="button"
                role="menuitemradio"
                className="pv-lang__option"
                lang={language.code}
                aria-checked={language.code === current}
                aria-disabled={pending !== null}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => pick(language.code)}
              >
                {language.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Смена языка — асинхронная операция: без объявления пользователь
          экранного диктора не узнаёт, что она вообще началась. */}
      <span className="pv-visually-hidden" role="status" aria-live="polite">
        {pending !== null ? text('lang.switching') : ''}
      </span>
    </div>
  )
}

export default LanguageSwitcher
