import { createMemo, createSignal, type Accessor } from "solid-js"

export type TranscriptWindowMetrics = {
  scrollTop: number
  viewportHeight: number
  mountedHeight: number
}

export type TranscriptWindowOptions = {
  /** Initial (or fixed, when `step`/adaptation is disabled) mounted-message count. */
  windowSize?: number
  /** Messages revealed/hidden per viewport shift. Defaults to a quarter of the window. */
  step?: number
  /** Rows assumed for a message that is hidden behind a spacer. */
  estimate?: number
  /** Rows of slack before the window follows the viewport. */
  margin?: number
  /** Smallest mounted-message count when the window sizes itself by rows. */
  minWindowSize?: number
  /** Largest mounted-message count when the window sizes itself by rows. */
  maxWindowSize?: number
}

/** Structural slice of a renderable the scroll anchoring measures. */
export type AnchorRow = { y: number; height: number }

export type ScrollAnchor<Row extends AnchorRow> = { row: Row; offset: number }

export type PendingScrollAnchor<Row extends AnchorRow> = {
  anchor: ScrollAnchor<Row>
  scrollHeight: number
  /** Content offset measured on the previous pass, to detect settled layout. */
  lastValue?: number
  tries: number
}

export type ScrollAnchorGeometry<Row extends AnchorRow> = {
  rows: readonly Row[]
  /** Index of the first row that may act as an anchor (fixed boxes before it are skipped). */
  from: number
  contentTop: number
  scrollHeight: number
}

/**
 * Record a row in the middle of the mounted ones, measured in content
 * coordinates, so a window move or a prepended page can put the same content
 * back under the viewport afterwards: scrollBy(newOffset - offset). Window
 * moves shift the mounted block uniformly, so any row that survives the
 * mutation measures the exact height delta; rows that are not laid out yet
 * (height 0) are skipped. offset is taken against the content box, whose own
 * translation cancels out of the delta.
 */
export function captureScrollAnchor<Row extends AnchorRow>(
  geometry: ScrollAnchorGeometry<Row>,
): PendingScrollAnchor<Row> | undefined {
  const rows = geometry.rows.slice(geometry.from).filter((row) => row.height > 0)
  const row = rows[Math.floor(rows.length / 2)]
  if (!row) return undefined
  return { anchor: { row, offset: row.y - geometry.contentTop }, scrollHeight: geometry.scrollHeight, tries: 0 }
}

/**
 * Scroll anchoring across window moves and prepended pages: capture before the
 * mutation, arm it once the mutation changed the window, then apply on a later
 * frame by scrolling the measured height delta above the viewport. When the
 * anchored row was unmounted, the total height delta is used instead.
 */
export function createScrollAnchoring<Row extends AnchorRow>(options: { atBottom: () => boolean }) {
  let pending: PendingScrollAnchor<Row> | undefined
  return {
    capture(geometry: ScrollAnchorGeometry<Row> | undefined) {
      if (!geometry) return undefined
      return captureScrollAnchor(geometry)
    },
    arm(captured: PendingScrollAnchor<Row>) {
      // Chained mutations keep the first anchor: it measures the accumulated
      // height change of everything that happened above it since.
      pending ??= captured
    },
    drop() {
      pending = undefined
    },
    apply(geometry: ScrollAnchorGeometry<Row>, scrollBy: (delta: number) => void) {
      const awaiting = pending
      if (!awaiting) return
      const row = geometry.rows.find((candidate) => candidate === awaiting.anchor.row)
      const offset = row ? row.y - geometry.contentTop : undefined
      const value = offset ?? geometry.scrollHeight
      // Lifecycle passes run before layout, and a fresh mutation shows up as a
      // mix of stale and fresh node geometry for a frame or two. Compensate
      // only once the anchor measures identically twice in a row.
      if (value !== awaiting.lastValue) {
        if (awaiting.tries < 10) pending = { ...awaiting, lastValue: value, tries: awaiting.tries + 1 }
        else pending = undefined
        return
      }
      pending = undefined
      if (options.atBottom()) return
      const delta = offset !== undefined ? offset - awaiting.anchor.offset : geometry.scrollHeight - awaiting.scrollHeight
      if (delta !== 0) scrollBy(delta)
    },
  }
}

// Frames the reader must stay still before the held rows below the viewport
// are released again.
const IDLE_FRAMES = 12

// Window UI nodes around the viewport, not the transcript store. The full
// message list remains available to timelines, forks and exports; spacers keep
// the scroll height of the whole loaded timeline so the scrollbar and scroll
// position do not collapse to the mounted slice. Older local messages are
// revealed as the reader scrolls, and only when the loaded timeline is
// exhausted does the route request an older server page.
export function createTranscriptWindow<T extends { id: string }>(
  messages: Accessor<readonly T[]>,
  options: TranscriptWindowOptions = {},
) {
  const margin = options.margin ?? 2
  const minWindow = Math.max(1, options.minWindowSize ?? 8)
  const maxWindow = Math.max(minWindow, options.maxWindowSize ?? 80)
  // A caller that pins `windowSize` wants a fixed count (tests, timelines). The
  // transcript route leaves it unset and lets the window size itself to the
  // viewport, the way row-based terminal virtualizers do.
  const adaptive = options.windowSize === undefined
  const [size, setSize] = createSignal(Math.max(1, options.windowSize ?? 32))
  const windowSize = () => (adaptive ? Math.max(minWindow, Math.min(maxWindow, size())) : size())
  // A quarter of the window per shift keeps each remount batch small, so
  // scrolling re-lays-out far fewer nodes at once. Read through a function so
  // it tracks a window that re-sizes itself.
  const step = () => Math.max(1, Math.min(windowSize(), options.step ?? Math.max(1, Math.floor(windowSize() / 4))))
  const [anchor, setAnchor] = createSignal<string>()
  const [estimate, setEstimate] = createSignal(Math.max(1, options.estimate ?? 6))
  // While the reader moves up, the trailing edge of the window holds the rows
  // it would otherwise unmount, so each upward shift only mounts new rows
  // above; going idle releases them. Held rows stay bounded by `maxWindow`
  // past the window start.
  const [holdEnd, setHoldEnd] = createSignal<number>()
  let lastScrollTop: number | undefined
  let idleFrames = 0

  const total = createMemo(() => messages().length)
  const maxStart = createMemo(() => Math.max(0, total() - windowSize()))
  const start = createMemo(() => {
    const id = anchor()
    if (id === undefined) return maxStart()
    const index = messages().findIndex((message) => message.id === id)
    // Keep the reader anchored to the message they scrolled to, even while the
    // live tail streams in behind them. Clamping an anchor to `maxStart` drops
    // it as soon as the anchor falls inside the newest window, and the window
    // then snaps to the streaming tail on every chunk — the transcript flicker
    // reported when reading earlier messages during an active drain. An
    // anchored window may be shorter than `windowSize` near the tail; the
    // trailing spacer keeps the scroll geometry intact, and returning to the
    // bottom clears the anchor through `follow`.
    return index < 0 ? maxStart() : Math.max(0, index)
  })
  const end = createMemo(() => {
    const held = holdEnd()
    if (held === undefined) return Math.min(total(), start() + windowSize())
    return Math.min(total(), Math.max(start() + windowSize(), Math.min(held, start() + maxWindow)))
  })
  const top = createMemo(() => start() * estimate())
  const bottom = createMemo(() => Math.max(0, total() - end()) * estimate())
  const window = createMemo(() => messages().slice(start(), end()))

  const moveTo = (index: number) => {
    const bounded = Math.max(0, Math.min(index, total() - 1))
    setAnchor(messages()[bounded]?.id)
  }

  return {
    start,
    end,
    top,
    bottom,
    messages: window,
    reset: () => {
      setAnchor(undefined)
      setHoldEnd(undefined)
    },
    reveal(id: string) {
      const index = messages().findIndex((message) => message.id === id)
      if (index < 0) return false
      if (index >= start() && index < end()) return false
      setAnchor(id)
      return true
    },
    /**
     * Follow the viewport: reveal local history as the reader scrolls up and
     * hide messages once they are far enough below. Hidden messages use
     * `estimate`, recalibrated from the mounted average on every pass so a
     * stale estimate cannot resize the timeline under the reader; the route
     * compensates the viewport for the spacer corrections through scroll
     * anchoring. At the bottom, where a correction cannot move the viewport,
     * the mounted count is also sized to cover the viewport by rows.
     */
    follow(metrics: TranscriptWindowMetrics) {
      const count = total()
      if (count <= windowSize()) {
        setAnchor(undefined)
        setHoldEnd(undefined)
        lastScrollTop = metrics.scrollTop
        idleFrames = 0
        return
      }
      const leading = top()
      const trailing = bottom()
      const content = Math.max(0, metrics.mountedHeight)
      const mounted = Math.max(1, end() - start())
      const atBottom = metrics.scrollTop + metrics.viewportHeight >= leading + content + trailing - margin
      const average = content / mounted
      if (average > 0 && Math.abs(average - estimate()) > estimate() * 0.25)
        setEstimate(Math.max(1, Math.round(average)))
      if (atBottom) {
        setAnchor(undefined)
        setHoldEnd(undefined)
        if (adaptive && metrics.viewportHeight > 0) {
          const rows = average > 0 ? average : estimate()
          const desired = Math.max(
            minWindow,
            Math.min(maxWindow, Math.ceil((metrics.viewportHeight + 2 * margin) / rows)),
          )
          // Re-size only past a dead band, so the layout/measure feedback loop
          // cannot oscillate every frame.
          if (Math.abs(desired - windowSize()) > Math.max(2, windowSize() * 0.25)) setSize(desired)
        }
        lastScrollTop = metrics.scrollTop
        idleFrames = 0
        return
      }
      const moving = lastScrollTop !== undefined && Math.abs(metrics.scrollTop - lastScrollTop) > 0.5
      idleFrames = moving ? 0 : idleFrames + 1
      if (idleFrames >= IDLE_FRAMES) setHoldEnd(undefined)
      if (anchor() === undefined) setAnchor(messages()[start()]?.id)
      const topGap = metrics.scrollTop - leading
      const bottomGap = leading + content - (metrics.scrollTop + metrics.viewportHeight)
      if (topGap < margin && start() > 0) {
        if (holdEnd() === undefined) setHoldEnd(end())
        moveTo(start() - step())
      } else if (bottomGap < margin && end() < count && metrics.scrollTop > leading) {
        moveTo(start() + step())
      }
      lastScrollTop = metrics.scrollTop
    },
  }
}
