// Keyboard rules of the language menu, kept free of React and of the DOM.
//
// WHY A SEPARATE MODULE. The selector used to declare listbox/option roles
// while handling no keys at all: assistive technology announced a listbox and
// then Arrow Down did nothing (CR-053). The replacement is the ARIA menu
// button pattern, and the part that is easy to get wrong — wrapping, Home/End,
// type-ahead, what closes the menu and what returns focus — lives here so it
// can be tested without a browser.

/** Keys that open the menu from the trigger, and where focus lands. */
const OPEN_KEYS = new Map([
  ['ArrowDown', 'checked'],
  ['Down', 'checked'],
  ['Enter', 'checked'],
  [' ', 'checked'],
  ['Spacebar', 'checked'],
  ['ArrowUp', 'last'],
  ['Up', 'last'],
])

const NO_ACTION = Object.freeze({ type: 'none', handled: false })

const move = (index) => Object.freeze({ type: 'move', index, handled: true })

const wrap = (index, count) => ((index % count) + count) % count

/**
 * True for a single printable character usable for type-ahead.
 *
 * Deliberately narrow: modifier combinations belong to the browser, and
 * multi-character key names ('Tab', 'F5') are not text.
 *
 * @param {string} key
 * @returns {boolean}
 */
export const isTypeaheadKey = (key) => typeof key === 'string' && [...key].length === 1 && key !== ' '

/**
 * Index of the next label starting with `char`, searched from `from` with
 * wrapping.
 *
 * @param {string[]} labels
 * @param {string} char
 * @param {number} from index to start searching at
 * @returns {number} matching index, or -1
 */
export const firstMatchIndex = (labels, char, from = 0) => {
  const needle = String(char).toLowerCase()
  const count = labels.length
  if (!count || !needle) return -1

  for (let step = 0; step < count; step += 1) {
    const index = wrap(from + step, count)
    if (String(labels[index] ?? '').toLowerCase().startsWith(needle)) return index
  }
  return -1
}

/**
 * What a key pressed on the closed trigger should do.
 *
 * @param {string} key value of KeyboardEvent.key
 * @returns {{type: 'open'|'none', focus?: 'checked'|'last', handled: boolean}}
 */
export const triggerKeyAction = (key) => {
  const focus = OPEN_KEYS.get(key)
  if (!focus) return NO_ACTION
  // Enter and Space already activate a <button>; reporting them as handled
  // lets the component open the menu on keydown and suppress the click that
  // would immediately close it again.
  return Object.freeze({ type: 'open', focus, handled: true })
}

/**
 * What a key pressed inside the open menu should do.
 *
 * @param {string} key value of KeyboardEvent.key
 * @param {{index: number, labels: string[]}} state current item and item labels
 * @returns {{type: 'move'|'close'|'none', index?: number,
 *   restoreFocus?: boolean, handled: boolean}}
 */
export const menuKeyAction = (key, { index = 0, labels = [] } = {}) => {
  const count = labels.length
  if (!count) return NO_ACTION

  switch (key) {
    case 'ArrowDown':
    case 'Down':
      return move(wrap(index + 1, count))
    case 'ArrowUp':
    case 'Up':
      return move(wrap(index - 1, count))
    case 'Home':
    case 'PageUp':
      return move(0)
    case 'End':
    case 'PageDown':
      return move(count - 1)
    case 'Escape':
    case 'Esc':
      // Escape returns focus to the trigger: without it focus falls to the
      // body and keyboard navigation restarts from the top of the page.
      return Object.freeze({ type: 'close', restoreFocus: true, handled: true })
    case 'Tab':
      // Tab closes the menu but keeps its own meaning, so the component must
      // not call preventDefault: focus has to continue to the next control.
      return Object.freeze({ type: 'close', restoreFocus: false, handled: false })
    case 'Enter':
    case ' ':
    case 'Spacebar':
      // Menu items are real buttons; the browser turns these into a click.
      return NO_ACTION
    default: {
      if (!isTypeaheadKey(key)) return NO_ACTION
      const match = firstMatchIndex(labels, key, index + 1)
      return match === -1 ? NO_ACTION : move(match)
    }
  }
}

/**
 * Item that receives focus when the menu opens.
 *
 * @param {'checked'|'last'|'first'} focus requested placement
 * @param {number} checkedIndex index of the currently selected language, or -1
 * @param {number} count number of items
 * @returns {number}
 */
export const initialMenuIndex = (focus, checkedIndex, count) => {
  if (count <= 0) return -1
  if (focus === 'last') return count - 1
  if (focus === 'checked' && checkedIndex >= 0 && checkedIndex < count) return checkedIndex
  return 0
}
