// CR-053: the keyboard contract of the language menu. No DOM environment is
// available in this project (vitest runs in node and jsdom is not a
// dependency), so the behaviour is tested where it actually lives — in the
// pure decision table the component drives its focus with.

import { describe, expect, it } from 'vitest'

import {
  firstMatchIndex,
  initialMenuIndex,
  isTypeaheadKey,
  menuKeyAction,
  triggerKeyAction,
} from './menuNavigation.js'

const LABELS = ['Русский', 'English', "O'zbekcha", 'Türkçe', 'العربية']

const act = (key, index) => menuKeyAction(key, { index, labels: LABELS })

describe('language menu keyboard', () => {
  it('moves down and wraps at the end', () => {
    expect(act('ArrowDown', 0)).toMatchObject({ type: 'move', index: 1, handled: true })
    expect(act('ArrowDown', LABELS.length - 1)).toMatchObject({ type: 'move', index: 0 })
  })

  it('moves up and wraps at the start', () => {
    expect(act('ArrowUp', 2)).toMatchObject({ type: 'move', index: 1, handled: true })
    expect(act('ArrowUp', 0)).toMatchObject({ type: 'move', index: LABELS.length - 1 })
  })

  it('jumps to the first and the last item', () => {
    expect(act('Home', 3)).toMatchObject({ type: 'move', index: 0 })
    expect(act('End', 1)).toMatchObject({ type: 'move', index: LABELS.length - 1 })
    expect(act('PageUp', 3)).toMatchObject({ type: 'move', index: 0 })
    expect(act('PageDown', 1)).toMatchObject({ type: 'move', index: LABELS.length - 1 })
  })

  it('closes on Escape and returns focus to the trigger', () => {
    expect(act('Escape', 2)).toMatchObject({ type: 'close', restoreFocus: true, handled: true })
  })

  it('closes on Tab without swallowing the key', () => {
    // handled: false keeps preventDefault away, so focus continues to the next
    // control instead of being parked on a closed menu.
    expect(act('Tab', 2)).toMatchObject({ type: 'close', restoreFocus: false, handled: false })
  })

  it('leaves Enter and Space to the button itself', () => {
    expect(act('Enter', 1)).toMatchObject({ type: 'none', handled: false })
    expect(act(' ', 1)).toMatchObject({ type: 'none', handled: false })
  })

  it('jumps to the next item starting with the typed character', () => {
    expect(act('e', 0)).toMatchObject({ type: 'move', index: 1 })
    expect(act('T', 0)).toMatchObject({ type: 'move', index: 3 })
    // Search starts after the current item and wraps around.
    expect(act('р', 1)).toMatchObject({ type: 'move', index: 0 })
    expect(act('z', 0)).toMatchObject({ type: 'none', handled: false })
  })

  it('ignores keys that are not text', () => {
    expect(isTypeaheadKey('F5')).toBe(false)
    expect(isTypeaheadKey(' ')).toBe(false)
    expect(isTypeaheadKey('ы')).toBe(true)
    expect(act('F5', 0)).toMatchObject({ type: 'none' })
  })

  it('does nothing when there are no items', () => {
    expect(menuKeyAction('ArrowDown', { index: 0, labels: [] })).toMatchObject({ type: 'none' })
    expect(menuKeyAction('ArrowDown')).toMatchObject({ type: 'none' })
  })

  it('finds a label from an arbitrary starting point', () => {
    expect(firstMatchIndex(LABELS, 'o', 0)).toBe(2)
    expect(firstMatchIndex(LABELS, 'o', 3)).toBe(2)
    expect(firstMatchIndex(LABELS, 'q', 0)).toBe(-1)
    expect(firstMatchIndex([], 'a', 0)).toBe(-1)
    expect(firstMatchIndex(LABELS, '', 0)).toBe(-1)
  })
})

describe('language menu trigger', () => {
  it('opens on Arrow Down, Enter and Space at the selected item', () => {
    for (const key of ['ArrowDown', 'Enter', ' ']) {
      expect(triggerKeyAction(key), key).toMatchObject({
        type: 'open',
        focus: 'checked',
        handled: true,
      })
    }
  })

  it('opens on Arrow Up at the last item', () => {
    expect(triggerKeyAction('ArrowUp')).toMatchObject({ type: 'open', focus: 'last' })
  })

  it('ignores every other key', () => {
    expect(triggerKeyAction('Tab')).toMatchObject({ type: 'none', handled: false })
    expect(triggerKeyAction('a')).toMatchObject({ type: 'none', handled: false })
  })
})

describe('initial menu item', () => {
  it('starts on the checked language', () => {
    expect(initialMenuIndex('checked', 3, 5)).toBe(3)
  })

  it('falls back to the first item when nothing is checked', () => {
    expect(initialMenuIndex('checked', -1, 5)).toBe(0)
    expect(initialMenuIndex('checked', 9, 5)).toBe(0)
  })

  it('starts on the last item when opened upwards', () => {
    expect(initialMenuIndex('last', 0, 5)).toBe(4)
  })

  it('reports no item for an empty menu', () => {
    expect(initialMenuIndex('checked', 0, 0)).toBe(-1)
  })
})
