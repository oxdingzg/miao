import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createTranscriptWindow } from "../../src/util/transcript-window"

test("history is mounted in pages without losing local messages or jump targets", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 205 }, (_, i) => ({ id: `message-${i}` }))
    const [messages, setMessages] = createSignal(all)
    const window = createTranscriptWindow(messages)
    expect(window.messages()).toHaveLength(40)
    expect(window.start()).toBe(165)
    expect(messages()).toHaveLength(205)
    expect(window.older()).toBe(true)
    expect(window.start()).toBe(125)
    expect(window.messages()[40]).toBe(all[165])
    setMessages([...all, { id: "new" }])
    expect(window.start()).toBe(125)
    expect(window.messages().at(-1)?.id).toBe("new")
    expect(window.reveal("message-3")).toBe(true)
    expect(window.start()).toBe(3)
    expect(window.older()).toBe(true)
    expect(window.start()).toBe(0)
    expect(window.older()).toBe(false)
    window.reset()
    expect(window.messages()).toHaveLength(40)
    expect(window.start()).toBe(166)
    expect(window.reveal("missing")).toBe(false)
    dispose()
  })
})

test("server-prepended pages preserve the anchor until explicitly revealed", () => {
  createRoot((dispose) => {
    const [messages, setMessages] = createSignal(Array.from({ length: 20 }, (_, i) => ({ id: `${i}` })))
    const window = createTranscriptWindow(messages)
    window.pin()
    setMessages([{ id: "older" }, ...messages()])
    expect(window.start()).toBe(1)
    expect(window.messages()[0].id).toBe("0")
    expect(window.older()).toBe(true)
    expect(window.messages()[0].id).toBe("older")
    window.reset()
    setMessages([{ id: "other-session" }])
    expect(window.messages().map((message) => message.id)).toEqual(["other-session"])
    dispose()
  })
})
