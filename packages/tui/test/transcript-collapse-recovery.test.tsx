import { expect, test } from "bun:test"
import { type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"
import { createTranscriptWindow } from "../src/util/transcript-window"

test("an idle transcript redraws after a large tool collapses without a scroll event", async () => {
  const messages = Array.from({ length: 1000 }, (_, index) => ({ id: `message-${index}` }))
  let scroll!: ScrollBoxRenderable
  let transcript!: ReturnType<typeof createTranscriptWindow<(typeof messages)[number]>>
  let collapse!: () => void
  let following = false
  const app = await testRender(
    () => {
      const [toolHeight, setToolHeight] = createSignal(40000)
      collapse = () => setToolHeight(1)
      transcript = createTranscriptWindow(() => messages, { windowSize: 40 })
      transcript.reveal("message-500")
      return (
        <SessionScrollbox
          ref={(value) => {
            scroll = value
            const pass = value.onLifecyclePass
            value.onLifecyclePass = () => {
              pass?.call(value)
              if (!following) return
              transcript.follow({
                scrollTop: value.scrollTop,
                viewportHeight: value.height,
                mountedHeight: value.scrollHeight - transcript.top() - transcript.bottom(),
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
          height={40}
        >
          <box height={transcript.top()} flexShrink={0} />
          <For each={transcript.messages()}>
            {(message) => (
              <text height={message.id === "message-520" ? toolHeight() : 1} flexShrink={0}>
                {message.id}
              </text>
            )}
          </For>
          <box height={transcript.bottom()} flexShrink={0} />
        </SessionScrollbox>
      )
    },
    { width: 60, height: 40 },
  )
  try {
    for (let frame = 0; frame < 3; frame++) await app.renderOnce()
    scroll.scrollTo(10000)
    following = true
    for (let frame = 0; frame < 10; frame++) await app.renderOnce()
    expect(transcript.start()).toBe(500)
    collapse()
    // Only renderer/layout passes follow; no wheel, pointer or keyboard event.
    for (let frame = 0; frame < 20; frame++) await app.renderOnce()
    expect(app.captureCharFrame()).toMatch(/message-\d+/)
    expect(transcript.start()).toBeGreaterThan(500)
    expect(transcript.messages().length).toBeLessThanOrEqual(40)
  } finally {
    app.renderer.destroy()
  }
})
