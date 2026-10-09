import { expect, test } from "bun:test"
import { type ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"
import { createScrollAnchoring, createTranscriptWindow, type ScrollAnchorGeometry } from "../src/util/transcript-window"

const HEIGHTS = Array.from({ length: 400 }, (_, index) => {
  if (index === 120) return 220
  if (index === 121) return 140
  if (index % 11 === 0) return 9
  return 1
})
const data = HEIGHTS.map((height, index) => ({ id: `message-${index}`, height }))

async function build() {
  let scroll!: ScrollBoxRenderable
  let transcript!: ReturnType<typeof createTranscriptWindow<(typeof data)[number]>>
  let setTail!: (pinned: boolean) => void
  let append!: () => void
  const app = await testRender(
    () => {
      const [messages, setMessages] = createSignal(data)
      append = () => setMessages((current) => [...current, { id: `live-${current.length}`, height: 2 }])
      transcript = createTranscriptWindow(messages)
      const anchoring = createScrollAnchoring<Renderable>({
        atBottom: () =>
          Boolean(scroll && !scroll.isDestroyed && scroll.scrollTop >= scroll.scrollHeight - scroll.height - 1),
      })
      let followPass = 0
      let lastMutation = -10
      const anchoringSettled = () => followPass - lastMutation >= 2
      let tailPinned = true
      let tailWant = true
      const tailSnap = 3
      setTail = (pinned) => {
        tailPinned = pinned
        tailWant = pinned
      }
      const anchorGeometry = (): ScrollAnchorGeometry<Renderable> | undefined => {
        if (!scroll || scroll.isDestroyed || scroll.scrollHeight <= 0) return undefined
        const rows = scroll.getChildren()
        const spacer = rows.findIndex((child) => child.id === "transcript-top-spacer")
        return { rows, from: Math.max(1, spacer + 1), contentTop: scroll.content.y, scrollHeight: scroll.scrollHeight }
      }
      const followWindow = (shared?: ScrollAnchorGeometry<Renderable>) => {
        if (!scroll || scroll.isDestroyed) return
        if (scroll.scrollHeight <= 0) {
          requestAnimationFrame(() => followWindow())
          return
        }
        followPass++
        const geometry = shared ?? anchorGeometry()
        const before = { start: transcript.start(), top: transcript.top(), bottom: transcript.bottom() }
        const captured = anchoringSettled() ? anchoring.capture(geometry) : undefined
        transcript.follow({
          scrollTop: scroll.scrollTop,
          viewportHeight: scroll.height,
          mountedHeight: scroll.scrollHeight - transcript.top() - transcript.bottom(),
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
      return (
        <SessionScrollbox
          ref={(value) => {
            scroll = value
            const pass = value.onLifecyclePass
            value.onLifecyclePass = () => {
              pass?.call(value)
              const geometry = anchorGeometry()
              if (geometry) anchoring.apply(geometry, (delta) => scroll?.scrollBy(delta))
              followWindow(geometry)
              const tailGap = scroll.scrollHeight - scroll.height - scroll.scrollTop
              if (tailWant && !tailPinned && tailGap >= 0 && tailGap <= tailSnap) tailPinned = true
              if (tailPinned && tailGap > 0) scroll.scrollTo(scroll.scrollHeight)
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
          <box height={1} />
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
  const settle = async (frames: number) => {
    for (let i = 0; i < frames; i++) await app.renderOnce()
  }
  const covered = () => {
    const leading = transcript.top()
    const mounted = transcript.messages().reduce((sum, message) => sum + message.height, 0)
    return scroll.scrollTop >= leading - 2 && scroll.scrollTop < leading + mounted
  }
  return { app, settle, covered, getScroll: () => scroll, setTail, append }
}

test("reading history never strands the viewport in a sustained blank", async () => {
  const targets = [250, 300, 550, 675, 700, 900, 1100]
  const worst: string[] = []
  for (const target of targets) {
    const { app, settle, covered, getScroll, setTail, append } = await build()
    try {
      await settle(20)
      setTail(false)
      getScroll().scrollTo(target)
      let streak = 0
      let maxStreak = 0
      let blanks = 0
      for (let i = 0; i < 40; i++) {
        if (i % 3 === 0) append()
        await settle(1)
        if (!covered()) {
          streak++
          blanks++
          maxStreak = Math.max(maxStreak, streak)
        } else streak = 0
      }
      if (maxStreak >= 4) worst.push(`target ${target}: maxStreak ${maxStreak}, total ${blanks}/40`)
    } finally {
      app.renderer.destroy()
    }
  }
  expect(worst).toEqual([])
})
