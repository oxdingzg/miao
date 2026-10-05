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

  const total = createMemo(() => messages().length)
  const maxStart = createMemo(() => Math.max(0, total() - windowSize()))
  const start = createMemo(() => {
    const id = anchor()
    if (id === undefined) return maxStart()
    const index = messages().findIndex((message) => message.id === id)
    return index < 0 ? maxStart() : Math.max(0, Math.min(index, maxStart()))
  })
  const end = createMemo(() => Math.min(total(), start() + windowSize()))
  const top = createMemo(() => start() * estimate())
  const bottom = createMemo(() => Math.max(0, total() - end()) * estimate())
  const window = createMemo(() => messages().slice(start(), end()))

  const moveTo = (index: number) => {
    const bounded = Math.max(0, Math.min(index, maxStart()))
    setAnchor(bounded >= maxStart() ? undefined : messages()[bounded]?.id)
  }

  return {
    start,
    end,
    top,
    bottom,
    messages: window,
    reset: () => setAnchor(undefined),
    reveal(id: string) {
      const index = messages().findIndex((message) => message.id === id)
      if (index < 0) return false
      if (index >= start() && index < end()) return false
      setAnchor(id)
      return true
    },
    /**
     * Follow the viewport: reveal local history as the reader scrolls up and
     * hide messages once they are far enough below. Only messages already
     * mounted are measured; hidden messages use `estimate`, which is
     * recalibrated from the mounted average while the reader sits at the
     * bottom, where a spacer correction cannot move the viewport. At that same
     * safe moment the mounted count is sized to cover the viewport by rows, so
     * tall messages mount few nodes and short ones still fill the screen.
     */
    follow(metrics: TranscriptWindowMetrics) {
      const count = total()
      if (count <= windowSize()) {
        setAnchor(undefined)
        return
      }
      const leading = top()
      const trailing = bottom()
      const content = Math.max(0, metrics.mountedHeight)
      const mounted = Math.max(1, end() - start())
      const atBottom = metrics.scrollTop + metrics.viewportHeight >= leading + content + trailing - margin
      if (atBottom) {
        setAnchor(undefined)
        const average = content / mounted
        if (average > 0 && Math.abs(average - estimate()) > estimate() * 0.25)
          setEstimate(Math.max(1, Math.round(average)))
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
        return
      }
      if (anchor() === undefined) setAnchor(messages()[start()]?.id)
      const topGap = metrics.scrollTop - leading
      const bottomGap = leading + content - (metrics.scrollTop + metrics.viewportHeight)
      if (topGap < margin && start() > 0) moveTo(start() - step())
      else if (bottomGap < margin && end() < count && metrics.scrollTop > leading) moveTo(start() + step())
    },
  }
}
