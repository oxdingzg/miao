import { expect, test } from "bun:test"
import { type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"
import { createTranscriptWindow } from "../src/util/transcript-window"

test.each([false, true])("partial collapse recovers the tail with blank old rows=%s", async (blankOldRows) => {
  const messages = Array.from({ length: 1000 }, (_, index) => ({ id: `message-${index}`, index }))
  let scroll: ScrollBoxRenderable | undefined
  let transcript: ReturnType<typeof createTranscriptWindow<(typeof messages)[number]>> | undefined
  let collapse: (() => void) | undefined
  let following = false
  const app = await testRender(
    () => {
      const [height, setHeight] = createSignal(40000)
      const [collapsed, setCollapsed] = createSignal(false)
      collapse = () => {
        setHeight(1)
        setCollapsed(true)
      }
      const window = createTranscriptWindow(() => messages, { windowSize: 40 })
      transcript = window
      window.reveal("message-955")
      return (
        <SessionScrollbox
          ref={(value) => {
            scroll = value
            const pass = value.onLifecyclePass
            value.onLifecyclePass = () => {
              pass?.call(value)
              if (!following) return
              window.follow({
                scrollTop: value.scrollTop,
                viewportHeight: value.height,
                mountedHeight: value.scrollHeight - window.top() - window.bottom(),
              })
            }
            value.ctx.registerLifecyclePass(value)
          }}
          alwaysShow={false}
          thumbColor="#808080"
          trackColor="#202020"
          hiddenColor="#101010"
          stickyScroll={false}
          width={60}
          height={36}
        >
          <box height={window.top()} flexShrink={0} />
          <For each={window.messages()}>
            {(message) => (
              // Internal timeline records have no rendered row, as in the route.
              <Show when={message.index % 2 === 0}>
                <text height={message.index === 956 ? height() : 1} flexShrink={0}>
                  {blankOldRows && collapsed() && message.index < 996 ? "" : message.id}
                </text>
              </Show>
            )}
          </For>
          <box height={window.bottom()} flexShrink={0} />
          <text height={1} flexShrink={0}>
            LIVE-STATE
          </text>
        </SessionScrollbox>
      )
    },
    { width: 60, height: 36 },
  )
  try {
    for (let frame = 0; frame < 3; frame++) await app.renderOnce()
    if (!scroll || !transcript || !collapse) throw new Error("transcript fixture did not mount")
    scroll.scrollTo(transcript.top() + 25)
    following = true
    for (let frame = 0; frame < 3; frame++) await app.renderOnce()
    expect(transcript.start()).toBe(955)
    collapse()
    // No keyboard/wheel event: layout itself must recover partial as well as
    // completely stranded viewports. The live footer is not transcript coverage.
    for (let frame = 0; frame < 24; frame++) await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("LIVE-STATE")
    expect(frame).toContain("message-998")
    expect(transcript.bottom()).toBe(0)
    expect(transcript.messages().length).toBeLessThanOrEqual(80)
  } finally {
    app.renderer.destroy()
  }
})
