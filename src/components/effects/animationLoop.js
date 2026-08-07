// CR-054: a canvas that nobody can see must not cost a frame.
//
// Both decorative canvases used to call requestAnimationFrame unconditionally
// from mount to unmount: a backgrounded tab and a widget three screens below
// the fold kept repainting. The gating logic lives here rather than in the
// components because it is the part worth testing, and because no DOM
// environment is available in this project (vitest runs in node) — everything
// the loop touches is injected.

/**
 * A frame loop that runs only while it is both started and visible.
 *
 * "Visible" is two independent conditions — the document is not hidden and the
 * observed element intersects the viewport — because either one alone makes the
 * painting pointless.
 *
 * @param {object} options
 * @param {(time: number) => void} options.onFrame  Paints exactly one frame.
 * @param {(callback: (time: number) => void) => unknown} options.requestFrame
 * @param {(handle: unknown) => void} options.cancelFrame
 * @returns {{
 *   start: () => void,
 *   stop: () => void,
 *   setPageVisible: (value: boolean) => void,
 *   setInViewport: (value: boolean) => void,
 *   readonly running: boolean,
 *   readonly requestedFrames: number,
 * }}
 */
export const createAnimationLoop = ({ onFrame, requestFrame, cancelFrame }) => {
  let handle = null
  let pending = false
  let started = false
  // Optimistic defaults: an IntersectionObserver reports asynchronously, and
  // waiting for its first callback would leave the first screen blank.
  let pageVisible = true
  let inViewport = true
  let requestedFrames = 0

  const schedule = () => {
    if (pending || !started || !pageVisible || !inViewport) return
    pending = true
    requestedFrames += 1
    handle = requestFrame(tick)
  }

  function tick(time) {
    pending = false
    handle = null
    onFrame(time)
    schedule()
  }

  const halt = () => {
    if (!pending) return
    pending = false
    if (handle !== null) cancelFrame(handle)
    handle = null
  }

  return {
    start() {
      started = true
      schedule()
    },
    stop() {
      started = false
      halt()
    },
    setPageVisible(value) {
      pageVisible = Boolean(value)
      if (pageVisible) schedule()
      else halt()
    },
    setInViewport(value) {
      inViewport = Boolean(value)
      if (inViewport) schedule()
      else halt()
    },
    get running() {
      return pending
    },
    get requestedFrames() {
      return requestedFrames
    },
  }
}

/**
 * Collapses a burst of events into one call per frame.
 *
 * A resize drag fires dozens of events per second, and every one of them used
 * to re-measure the canvas and rebuild its particle array.
 *
 * @returns {(() => void) & {cancel: () => void}}
 */
export const throttleToFrame = (callback, view = globalThis) => {
  let handle = null

  const run = () => {
    handle = null
    callback()
  }

  const invoke = () => {
    if (handle !== null) return
    handle = view.requestAnimationFrame(run)
  }

  invoke.cancel = () => {
    if (handle === null) return
    view.cancelAnimationFrame(handle)
    handle = null
  }

  return invoke
}

/**
 * Wires a loop to the page: it stops on `document.hidden` and whenever
 * `element` leaves the viewport, and releases both listeners on dispose.
 *
 * `rootMargin` starts the loop slightly before the element scrolls in, so the
 * first visible frame is already a painted one.
 *
 * @returns {{loop: ReturnType<typeof createAnimationLoop>, dispose: () => void}}
 */
export const attachAnimationLoop = ({
  element,
  onFrame,
  view = globalThis,
  rootMargin = '120px',
}) => {
  const doc = view.document
  const loop = createAnimationLoop({
    onFrame,
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (handle) => view.cancelAnimationFrame(handle),
  })

  const onVisibilityChange = () => loop.setPageVisible(!doc.hidden)
  doc.addEventListener('visibilitychange', onVisibilityChange)

  let observer = null
  if (element && typeof view.IntersectionObserver === 'function') {
    observer = new view.IntersectionObserver(
      (entries) => loop.setInViewport(entries.some((entry) => entry.isIntersecting)),
      { rootMargin }
    )
    observer.observe(element)
  }

  loop.setPageVisible(!doc.hidden)
  loop.start()

  return {
    loop,
    dispose() {
      loop.stop()
      doc.removeEventListener('visibilitychange', onVisibilityChange)
      observer?.disconnect()
    },
  }
}
