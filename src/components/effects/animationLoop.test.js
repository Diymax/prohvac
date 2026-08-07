// CR-054: the measurement behind "active animation loops: 2 -> 0". Counting
// requested frames is the only way to state that number without a browser.

import { describe, expect, it, vi } from 'vitest'

import { attachAnimationLoop, createAnimationLoop, throttleToFrame } from './animationLoop.js'

/** A requestAnimationFrame that only advances when the test says so. */
const createClock = () => {
  const queued = new Map()
  let nextHandle = 1
  let time = 0

  return {
    requestAnimationFrame(callback) {
      const handle = nextHandle
      nextHandle += 1
      queued.set(handle, callback)
      return handle
    },
    cancelAnimationFrame(handle) {
      queued.delete(handle)
    },
    /** Runs every callback scheduled so far. Returns how many ran. */
    flush() {
      const callbacks = [...queued.values()]
      queued.clear()
      time += 16
      callbacks.forEach((callback) => callback(time))
      return callbacks.length
    },
    get pending() {
      return queued.size
    },
  }
}

const createView = (clock) => {
  const listeners = new Map()
  const observers = []

  const doc = {
    hidden: false,
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  }

  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      this.observed = []
      this.disconnected = false
      observers.push(this)
    }

    observe(node) {
      this.observed.push(node)
    }

    disconnect() {
      this.disconnected = true
    }
  }

  return {
    document: doc,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    IntersectionObserver: FakeIntersectionObserver,
    observers,
    emitVisibility(hidden) {
      doc.hidden = hidden
      listeners.get('visibilitychange')?.()
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

const loopOn = (clock, onFrame = () => {}) =>
  createAnimationLoop({
    onFrame,
    requestFrame: clock.requestAnimationFrame,
    cancelFrame: clock.cancelAnimationFrame,
  })

describe('animation loop gating', () => {
  it('paints continuously while started and visible', () => {
    const clock = createClock()
    const onFrame = vi.fn()
    const loop = loopOn(clock, onFrame)

    loop.start()
    clock.flush()
    clock.flush()
    clock.flush()

    expect(onFrame).toHaveBeenCalledTimes(3)
    expect(loop.running).toBe(true)
  })

  it('does not request a frame before it is started', () => {
    const clock = createClock()
    const loop = loopOn(clock)

    loop.setPageVisible(true)
    loop.setInViewport(true)

    expect(loop.requestedFrames).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('stops requesting frames once the page is hidden', () => {
    const clock = createClock()
    const onFrame = vi.fn()
    const loop = loopOn(clock, onFrame)

    loop.start()
    clock.flush()
    loop.setPageVisible(false)

    expect(clock.pending).toBe(0)
    const before = loop.requestedFrames
    clock.flush()
    expect(loop.requestedFrames).toBe(before)
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(loop.running).toBe(false)
  })

  it('stops requesting frames once the element leaves the viewport', () => {
    const clock = createClock()
    const loop = loopOn(clock)

    loop.start()
    clock.flush()
    loop.setInViewport(false)

    expect(clock.pending).toBe(0)
    const before = loop.requestedFrames
    clock.flush()
    expect(loop.requestedFrames).toBe(before)
  })

  it('needs both conditions back before it resumes', () => {
    const clock = createClock()
    const loop = loopOn(clock)

    loop.start()
    loop.setPageVisible(false)
    loop.setInViewport(false)

    loop.setPageVisible(true)
    expect(loop.running).toBe(false)

    loop.setInViewport(true)
    expect(loop.running).toBe(true)
  })

  it('never queues two frames at once', () => {
    const clock = createClock()
    const loop = loopOn(clock)

    loop.start()
    loop.start()
    loop.setPageVisible(true)
    loop.setInViewport(true)

    expect(clock.pending).toBe(1)
  })

  it('cancels the queued frame on stop', () => {
    const clock = createClock()
    const onFrame = vi.fn()
    const loop = loopOn(clock, onFrame)

    loop.start()
    loop.stop()

    expect(clock.pending).toBe(0)
    expect(clock.flush()).toBe(0)
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('stays stopped when visibility changes after stop', () => {
    const clock = createClock()
    const loop = loopOn(clock)

    loop.start()
    loop.stop()
    loop.setPageVisible(true)
    loop.setInViewport(true)

    expect(clock.pending).toBe(0)
  })
})

describe('frame throttle', () => {
  it('collapses a burst of events into one call', () => {
    const clock = createClock()
    const callback = vi.fn()
    const invoke = throttleToFrame(callback, { ...clock })

    for (let i = 0; i < 25; i += 1) invoke()
    expect(callback).not.toHaveBeenCalled()

    clock.flush()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('accepts the next burst after the frame ran', () => {
    const clock = createClock()
    const callback = vi.fn()
    const invoke = throttleToFrame(callback, { ...clock })

    invoke()
    clock.flush()
    invoke()
    clock.flush()

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('drops the pending call when cancelled', () => {
    const clock = createClock()
    const callback = vi.fn()
    const invoke = throttleToFrame(callback, { ...clock })

    invoke()
    invoke.cancel()
    invoke.cancel()
    clock.flush()

    expect(callback).not.toHaveBeenCalled()
  })
})

describe('attachAnimationLoop', () => {
  it('reacts to visibilitychange and to the observer', () => {
    const clock = createClock()
    const view = createView(clock)
    const element = { id: 'canvas' }
    const attached = attachAnimationLoop({ element, onFrame: () => {}, view })

    expect(attached.loop.running).toBe(true)
    expect(view.observers[0].observed).toEqual([element])

    view.emitVisibility(true)
    expect(attached.loop.running).toBe(false)

    view.emitVisibility(false)
    expect(attached.loop.running).toBe(true)

    view.observers[0].callback([{ isIntersecting: false }])
    expect(attached.loop.running).toBe(false)

    view.observers[0].callback([{ isIntersecting: true }])
    expect(attached.loop.running).toBe(true)
  })

  it('starts halted when the tab is already in the background', () => {
    const clock = createClock()
    const view = createView(clock)
    view.document.hidden = true

    const attached = attachAnimationLoop({ element: {}, onFrame: () => {}, view })

    expect(attached.loop.running).toBe(false)
    expect(attached.loop.requestedFrames).toBe(0)
  })

  it('runs without IntersectionObserver support', () => {
    const clock = createClock()
    const view = { ...createView(clock), IntersectionObserver: undefined }
    const attached = attachAnimationLoop({ element: {}, onFrame: () => {}, view })

    expect(attached.loop.running).toBe(true)
    attached.dispose()
  })

  it('releases the listener, the observer and the frame on dispose', () => {
    const clock = createClock()
    const view = createView(clock)
    const onFrame = vi.fn()
    const attached = attachAnimationLoop({ element: {}, onFrame, view })

    attached.dispose()

    expect(view.listenerCount).toBe(0)
    expect(view.observers[0].disconnected).toBe(true)
    expect(clock.pending).toBe(0)
    expect(clock.flush()).toBe(0)
    expect(onFrame).not.toHaveBeenCalled()
  })
})
