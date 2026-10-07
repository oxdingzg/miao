import { expect, test } from "bun:test"
import { Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { For } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"
import { createScrollAnchoring, createTranscriptWindow } from "../src/util/transcript-window"

const COUNT = 500
const ROW = 3
const WINDOW = 20
const LEADING = 1
const WORLD_HEIGHT = 20

const data = Array.from({ length: COUNT }, (_, index) => ({ id: `message-${index}`, text: `message ${index}` }))

test("default options mount a bounded window and shift by a small step", () => {
  const data = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}` }))
  const window = createTranscriptWindow(() => data)

  // At the bottom the window is the newest `windowSize` messages.
  expect(window.messages().length).toBe(32)

  // One shift near the top of the mounted window moves by `step`, not by half
  // the window.
  const before = window.start()
  window.follow({ scrollTop: window.top() + 0.5, viewportHeight: 20, mountedHeight: 32 * 6 })
  expect(before - window.start()).toBe(8)
})

test("sizes the mounted window to the viewport by rows", () => {
  const data = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}` }))

  // Tall messages (10 rows each) with a 40-row viewport: mount only a few, at
  // least the minimum.
  const tall = createTranscriptWindow(() => data)
  tall.follow({ scrollTop: 1_000_000, viewportHeight: 40, mountedHeight: 32 * 10 })
  expect(tall.messages().length).toBe(8)

  // Short messages (1.5 rows each) with a 60-row viewport: grow to cover it.
  const short = createTranscriptWindow(() => data)
  short.follow({ scrollTop: 1_000_000, viewportHeight: 60, mountedHeight: 32 * 1.5 })
  expect(short.messages().length).toBe(43)
})

test("a long session mounts only a bounded window while preserving scroll height and top", async () => {
  let window!: ReturnType<typeof createTranscriptWindow<(typeof data)[number]>>
  let scroll!: ScrollBoxRenderable
  const before = Renderable.renderablesByNumber.size

  const app = await testRender(
    () => {
      const transcript = createTranscriptWindow(() => data, {
        windowSize: WINDOW,
        estimate: ROW,
        step: WINDOW,
        margin: 2,
        maxWindowSize: 2 * WINDOW,
      })
      window = transcript
      return (
        <box width={60} height={WORLD_HEIGHT} flexDirection="column">
          <SessionScrollbox
            ref={(value) => {
              scroll = value
              value.onLifecyclePass = () =>
                transcript.follow({
                  scrollTop: value.scrollTop,
                  viewportHeight: value.height,
                  mountedHeight: value.scrollHeight - transcript.top() - transcript.bottom(),
                })
              value.ctx.registerLifecyclePass(value)
            }}
            alwaysShow={true}
            thumbColor="#808080"
            trackColor="#202020"
            hiddenColor="#101010"
            stickyScroll={true}
            stickyStart="bottom"
            width={60}
            height={WORLD_HEIGHT}
          >
            <box height={LEADING} />
            <box height={transcript.top()} flexShrink={0} />
            <For each={transcript.messages()}>{(message) => <text height={ROW}>{message.text}</text>}</For>
            <box height={transcript.bottom()} flexShrink={0} />
          </SessionScrollbox>
        </box>
      )
    },
    { width: 60, height: WORLD_HEIGHT },
  )

  try {
    await app.renderOnce()
    await app.renderOnce()

    // Only the window is mounted, but the spacers keep the full timeline height.
    expect(scroll.getChildren().length).toBeLessThanOrEqual(WINDOW + 3)
    expect(Renderable.renderablesByNumber.size - before).toBeLessThan(150)
    expect(scroll.scrollHeight).toBe(LEADING + COUNT * ROW)
    expect(window.start()).toBe(COUNT - WINDOW)
    expect(window.messages().at(-1)?.id).toBe(`message-${COUNT - 1}`)

    // Scrolling to the top walks the window back until the oldest node is mounted.
    // Upward shifts hold the trailing rows, so the mounted count stays bounded
    // only by maxWindowSize until the reader comes to rest.
    scroll.scrollTo(0)
    for (let i = 0; i < 60 && window.start() > 0; i++) await app.renderOnce()
    expect(window.start()).toBe(0)
    expect(window.top()).toBe(0)
    expect(window.messages()[0].id).toBe("message-0")
    expect(scroll.getChildren().length).toBeLessThanOrEqual(2 * WINDOW + 3)
    expect(scroll.scrollHeight).toBe(LEADING + COUNT * ROW)
  } finally {
    app.renderer.destroy()
  }
})

test("a window move keeps the content under the viewport in place", async () => {
  let scroll!: ScrollBoxRenderable
  // Rows alternate tall and short so the spacer estimate cannot match exactly.
  const data = Array.from({ length: COUNT }, (_, index) => ({
    id: `message-${index}`,
    text: `message ${index}`,
    height: index % 2 === 0 ? 7 : 2,
  }))
  let transcript!: ReturnType<typeof createTranscriptWindow<(typeof data)[number]>>
  const anchoring = createScrollAnchoring<Renderable>({
    atBottom: () => scroll.scrollTop >= scroll.scrollHeight - scroll.height - 1,
  })
  // Mirrors the route wiring: anchors are only captured from settled layout.
  let followPass = 0
  let lastMutation = -10
  const app = await testRender(
    () => {
      transcript = createTranscriptWindow(() => data, {
        windowSize: WINDOW,
        estimate: 4,
        step: 10,
        margin: 2,
        maxWindowSize: 60,
      })
      return (
        <box width={60} height={WORLD_HEIGHT} flexDirection="column">
          <SessionScrollbox
            ref={(value) => {
              scroll = value
              const pass = value.onLifecyclePass
              value.onLifecyclePass = () => {
                pass?.call(value)
                const rows = value.getChildren()
                const spacer = rows.findIndex((child) => child.id === "transcript-top-spacer")
                const geometry = {
                  rows,
                  from: Math.max(1, spacer + 1),
                  contentTop: value.content.y,
                  scrollHeight: value.scrollHeight,
                }
                anchoring.apply(geometry, (delta) => value.scrollBy(delta))
                followPass++
                const before = { start: transcript.start(), top: transcript.top(), bottom: transcript.bottom() }
                const captured = followPass - lastMutation >= 2 ? anchoring.capture(geometry) : undefined
                transcript.follow({
                  scrollTop: value.scrollTop,
                  viewportHeight: value.height,
                  mountedHeight: value.scrollHeight - transcript.top() - transcript.bottom(),
                })
                if (
                  transcript.start() !== before.start ||
                  transcript.top() !== before.top ||
                  transcript.bottom() !== before.bottom
                ) {
                  lastMutation = followPass
                  if (captured) anchoring.arm(captured)
                }
              }
              value.ctx.registerLifecyclePass(value)
            }}
            alwaysShow={true}
            thumbColor="#808080"
            trackColor="#202020"
            hiddenColor="#101010"
            stickyScroll={true}
            stickyStart="bottom"
            width={60}
            height={WORLD_HEIGHT}
          >
            <box height={LEADING} />
            <box id="transcript-top-spacer" height={transcript.top()} flexShrink={0} />
            <For each={transcript.messages()}>{(message) => <text height={message.height}>{message.text}</text>}</For>
            <box height={transcript.bottom()} flexShrink={0} />
          </SessionScrollbox>
        </box>
      )
    },
    { width: 60, height: WORLD_HEIGHT },
  )

  try {
    await app.renderOnce()
    await app.renderOnce()
    await app.renderOnce()
    expect(scroll.scrollTop).toBeGreaterThan(0)

    // The row at the top of the viewport is the anchor whose screen position
    // must survive the window move.
    const rows = scroll.getChildren()
    const spacer = rows.findIndex((child) => child.id === "transcript-top-spacer")
    const anchored = rows
      .slice(Math.max(1, spacer + 1))
      .find((child) => child.y + child.height > scroll.viewport.y)!
    const relative = () => anchored.y - scroll.content.y - scroll.scrollTop
    const before = relative()

    // One upward scroll: the window mounts rows above, and the anchoring pass
    // puts the shifted content back under the viewport within the next frame.
    scroll.scrollBy(-100)
    for (let i = 0; i < 6; i++) await app.renderOnce()

    expect(transcript.start()).toBeLessThan(COUNT - WINDOW)
    expect(relative()).toBeGreaterThanOrEqual(before + 99)
    expect(relative()).toBeLessThanOrEqual(before + 101)

    // A burst of further scrolls walks the original anchor out of the window;
    // once it settles, a fresh anchor must still hold the content in place.
    for (let burst = 0; burst < 4; burst++) {
      scroll.scrollBy(-80)
      await app.renderOnce()
      await app.renderOnce()
    }
    for (let i = 0; i < 4; i++) await app.renderOnce()
    expect(scroll.scrollTop).toBeGreaterThan(0)

    const rows2 = scroll.getChildren()
    const anchored2 = rows2
      .slice(Math.max(1, rows2.findIndex((child) => child.id === "transcript-top-spacer") + 1))
      .find((child) => child.y + child.height > scroll.viewport.y)!
    const relative2 = () => anchored2.y - scroll.content.y - scroll.scrollTop
    const before2 = relative2()
    scroll.scrollBy(-80)
    for (let i = 0; i < 6; i++) await app.renderOnce()
    expect(relative2()).toBeGreaterThanOrEqual(before2 + 79)
    expect(relative2()).toBeLessThanOrEqual(before2 + 81)
  } finally {
    app.renderer.destroy()
  }
})
