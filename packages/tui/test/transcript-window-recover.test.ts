import { expect, test } from "bun:test"
import { createTranscriptWindow } from "../src/util/transcript-window"

const items = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` }))

// Settle the adaptive window at the tail, then read the geometry the way the
// route measures it: spacers from the window, mounted height from real rows.
function follow(
  window: ReturnType<typeof createTranscriptWindow<{ id: string }>>,
  scrollTop: number,
  viewportHeight = 40,
) {
  const mounted = window.end() - window.start()
  window.follow({
    scrollTop,
    viewportHeight,
    mountedHeight: mounted * 6,
  })
}

// The recovery jump waits for a second consecutive stranded pass, so a
// mid-move frame with mixed geometry cannot fling the viewport.
function stranded(
  window: ReturnType<typeof createTranscriptWindow<{ id: string }>>,
  scrollTop: number,
  viewportHeight = 40,
) {
  follow(window, scrollTop, viewportHeight)
  follow(window, scrollTop, viewportHeight)
}

test("a viewport stranded above the mounted block jumps to cover it", () => {
  const window = createTranscriptWindow(() => items)
  follow(window, 1152 + 192 - 40)
  expect(window.start()).toBe(192)

  // A scrollbar fling parks the viewport far above the mounted block.
  stranded(window, 100)
  const leading = window.start() * 6
  expect(leading).toBeLessThanOrEqual(100)
  expect(leading + (window.end() - window.start()) * 6).toBeGreaterThanOrEqual(140)
})

test("a viewport stranded below the mounted block jumps to cover it", () => {
  const window = createTranscriptWindow(() => items)
  follow(window, 1152 + 192 - 40)
  stranded(window, 100)
  stranded(window, 500)
  const leading = window.start() * 6
  expect(leading).toBeLessThanOrEqual(500)
  expect(leading + (window.end() - window.start()) * 6).toBeGreaterThanOrEqual(540)
})

test("a viewport overlapping the mounted block keeps stepped chasing", () => {
  const window = createTranscriptWindow(() => items)
  follow(window, 1152 + 192 - 40)
  const atTail = window.start()
  stranded(window, 100)
  const jumped = window.start()
  // Inside the block the window only steps by a quarter per pass.
  follow(window, jumped * 6 + 10)
  expect(window.start()).toBeLessThan(atTail)
  expect(window.start() - jumped).toBeLessThanOrEqual(12)
})

test("a single stranded pass only steps, never jumps", () => {
  const window = createTranscriptWindow(() => items)
  follow(window, 1152 + 192 - 40)
  follow(window, 100)
  // One regular step (a quarter of the window), not a jump to the viewport.
  expect(window.start()).toBe(190)
})
