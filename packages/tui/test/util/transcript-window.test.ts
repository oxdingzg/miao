import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createTranscriptWindow } from "../../src/util/transcript-window"

test("history is mounted in bounded pages without losing local messages or jump targets", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 205 }, (_, i) => ({ id: `message-${i}` }))
    const [messages, setMessages] = createSignal(all)
    const window = createTranscriptWindow(messages)
    expect(window.messages()).toHaveLength(40)
    expect(window.start()).toBe(165)
    expect(messages()).toHaveLength(205)
    expect(window.reveal("message-125")).toBe(true)
    expect(window.start()).toBe(125)
    expect(window.messages()).toHaveLength(40)
    expect(window.messages()[0].id).toBe("message-125")
    expect(window.messages().at(-1)?.id).toBe("message-164")
    setMessages([...all, { id: "new" }])
    expect(window.start()).toBe(125)
    expect(window.messages().at(-1)?.id).toBe("message-164")
    expect(window.reveal("message-3")).toBe(true)
    expect(window.start()).toBe(3)
    expect(window.reveal("message-3")).toBe(false)
    window.reset()
    expect(window.messages()).toHaveLength(40)
    expect(window.start()).toBe(166)
    expect(window.reveal("missing")).toBe(false)
    dispose()
  })
})

test("spacers account for every message outside the window", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 205 }, (_, i) => ({ id: `${i}` }))
    const window = createTranscriptWindow(createSignal(all)[0], { windowSize: 40, estimate: 3 })
    expect(window.top()).toBe(window.start() * 3)
    expect(window.bottom()).toBe((205 - window.end()) * 3)
    expect(window.top() + window.messages().length * 3 + window.bottom()).toBe(205 * 3)
    dispose()
  })
})

test("follow reveals local history above and hides it again below", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 300 }, (_, i) => ({ id: `${i}` }))
    const window = createTranscriptWindow(createSignal(all)[0], { windowSize: 40, estimate: 3, margin: 2 })
    const mounted = 40 * 3
    // Sitting at the bottom pins the newest window.
    window.follow({ scrollTop: 300 * 3 - 20, viewportHeight: 20, mountedHeight: mounted })
    expect(window.start()).toBe(260)
    expect(window.bottom()).toBe(0)
    // Scrolling into the leading spacer reveals an older page locally.
    window.follow({ scrollTop: window.top() - 1, viewportHeight: 20, mountedHeight: mounted })
    expect(window.start()).toBe(240)
    // Scrolling further up eventually reaches the oldest loaded message.
    for (let i = 0; i < 20; i++)
      window.follow({ scrollTop: window.top() - 1, viewportHeight: 20, mountedHeight: mounted })
    expect(window.start()).toBe(0)
    expect(window.top()).toBe(0)
    // Scrolling down into the trailing spacer brings back the newer messages.
    window.follow({ scrollTop: 0, viewportHeight: 20, mountedHeight: mounted })
    const before = window.start()
    window.follow({
      scrollTop: window.top() + mounted - 1,
      viewportHeight: 20,
      mountedHeight: mounted,
    })
    expect(window.start()).toBeGreaterThan(before)
    expect(window.bottom()).toBeGreaterThan(0)
    dispose()
  })
})

test("server-prepended pages preserve the anchor until explicitly revealed", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 100 }, (_, i) => ({ id: `${i}` }))
    const [messages, setMessages] = createSignal(all)
    const window = createTranscriptWindow(messages)
    expect(window.start()).toBe(60)
    window.reveal("55")
    setMessages([{ id: "older-1" }, { id: "older-0" }, ...messages()])
    expect(window.start()).toBe(57)
    expect(window.messages()[0].id).toBe("55")
    window.reset()
    expect(window.start()).toBe(62)
    window.reveal("older-0")
    expect(window.start()).toBe(1)
    setMessages([{ id: "other-session" }])
    expect(window.messages().map((message) => message.id)).toEqual(["other-session"])
    dispose()
  })
})
