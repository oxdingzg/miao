import { expect, test } from "bun:test"
import { type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"
import { createTranscriptWindow } from "../src/util/transcript-window"

test("a short live tail after tall history fills the viewport without remount oscillation", async () => {
  const data = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}`, height: index < 492 ? 100 : 2 }))
  let append!: () => void
  let scroll!: ScrollBoxRenderable
  let transcript!: ReturnType<typeof createTranscriptWindow<(typeof data)[number]>>
  const app = await testRender(
    () => {
      const [messages, setMessages] = createSignal(data)
      append = () =>
        setMessages((current) => [
          ...current,
          ...Array.from({ length: 5 }, (_, index) => ({ id: `live-${index}`, height: 2 })),
        ])
      transcript = createTranscriptWindow(messages)
      return (
        <SessionScrollbox
          ref={(value) => {
            scroll = value
            const pass = value.onLifecyclePass
            value.onLifecyclePass = () => {
              pass?.call(value)
              transcript.follow({
                scrollTop: value.scrollTop,
                viewportHeight: value.height,
                mountedHeight: value.scrollHeight - transcript.top() - transcript.bottom(),
              })
              value.scrollTo(value.scrollHeight)
            }
            value.ctx.registerLifecyclePass(value)
          }}
          alwaysShow={false}
          thumbColor="#808080"
          trackColor="#202020"
          hiddenColor="#101010"
          stickyScroll={true}
          stickyStart="bottom"
          width={60}
          height={40}
        >
          <box height={transcript.top()} flexShrink={0} />
          <For each={transcript.messages()}>
            {(message) => (
              <text height={message.height} flexShrink={0}>
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
    const sizes: number[] = []
    for (let frame = 0; frame < 50; frame++) {
      await app.renderOnce()
      if (frame >= 30) sizes.push(transcript.messages().length)
    }
    expect(new Set(sizes).size).toBe(1)
    expect(transcript.messages().reduce((sum, message) => sum + message.height, 0)).toBeGreaterThanOrEqual(
      scroll.height,
    )
    expect(transcript.messages().length).toBeLessThanOrEqual(80)
    append()
    const liveSizes: number[] = []
    for (let frame = 0; frame < 40; frame++) {
      await app.renderOnce()
      if (frame >= 20) liveSizes.push(transcript.messages().length)
    }
    expect(new Set(liveSizes).size).toBe(1)
    expect(transcript.messages().at(-1)?.id).toBe("live-4")
    expect(transcript.messages().reduce((sum, message) => sum + message.height, 0)).toBeGreaterThanOrEqual(
      scroll.height,
    )
  } finally {
    app.renderer.destroy()
  }
})

test("reset releases the previous viewport's coverage floor", () => {
  const data = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}` }))
  const transcript = createTranscriptWindow(() => data)
  transcript.follow({ scrollTop: 1_000_000, viewportHeight: 60, mountedHeight: 48 })
  expect(transcript.messages().length).toBeGreaterThan(32)
  transcript.reset()
  transcript.follow({ scrollTop: 1_000_000, viewportHeight: 40, mountedHeight: transcript.messages().length * 100 })
  expect(transcript.messages().length).toBe(8)
})
