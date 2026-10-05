import { expect, test } from "bun:test"
import { Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { For } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"
import { createTranscriptWindow } from "../src/util/transcript-window"

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
    scroll.scrollTo(0)
    for (let i = 0; i < 60 && window.start() > 0; i++) await app.renderOnce()
    expect(window.start()).toBe(0)
    expect(window.top()).toBe(0)
    expect(window.messages()[0].id).toBe("message-0")
    expect(scroll.getChildren().length).toBeLessThanOrEqual(WINDOW + 3)
    expect(scroll.scrollHeight).toBe(LEADING + COUNT * ROW)
  } finally {
    app.renderer.destroy()
  }
})
