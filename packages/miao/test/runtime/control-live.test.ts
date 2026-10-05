import { describe, expect, test } from "bun:test"
import { RuntimeControlLive } from "../../src/runtime/control-live"

function event(type: string, sessionID = "session", assistantMessageID = "message", extra = {}) {
  return { type: "session.next." + type, data: { sessionID, assistantMessageID, textID: "text", ...extra } }
}

describe("Remote live projection", () => {
  test("returns full transient values and removes them at durable settlement", () => {
    const live = RuntimeControlLive.make()
    live.accept(event("step.started"))
    live.accept(event("text.started"))
    live.accept(event("text.delta", "session", "message", { delta: "你好" }))
    live.accept(event("text.delta", "session", "message", { delta: "世界" }))
    const first = live.snapshot("session")
    expect(first.parts[0]?.text).toBe("你好世界")
    first.parts[0]!.text = "changed by client"
    expect(live.snapshot("session").parts[0]?.text).toBe("你好世界")
    live.accept(event("text.ended"))
    expect(live.snapshot("session").parts).toEqual([])
    live.accept(event("step.ended"))
    expect(live.snapshot("session").messageID).toBeNull()
  })
  test("does not merge sessions or late fragments from another turn", () => {
    const live = RuntimeControlLive.make()
    live.accept(event("step.started"))
    live.accept(event("text.started"))
    live.accept(event("step.started", "session", "next"))
    live.accept(event("text.started", "session", "next"))
    live.accept(event("text.delta", "session", "message", { delta: "old" }))
    live.accept(event("step.failed", "session", "message"))
    expect(live.snapshot("session").messageID).toBe("next")
    expect(live.snapshot("session").parts[0]?.text).toBe("")
    expect(live.snapshot("other").parts).toEqual([])
  })
  test("bounds UTF-8 fragments and expires abandoned streams", () => {
    const clock = { now: 0 }
    const live = RuntimeControlLive.make(() => clock.now)
    live.accept(event("step.started"))
    live.accept(event("text.started"))
    live.accept(event("text.delta", "session", "message", { delta: "猫".repeat(100_000) }))
    const part = live.snapshot("session").parts[0]!
    expect(new TextEncoder().encode(part.text).length).toBeLessThanOrEqual(256 * 1024)
    expect(part.truncated).toBe(true)
    expect(part.text.includes("�")).toBe(false)
    clock.now = 120_001
    expect(live.snapshot("session").messageID).toBeNull()
  })
  test("bounds total retained text and the number of parts", () => {
    const live = RuntimeControlLive.make()
    for (let i = 0; i < 17; i++) {
      const session = "large" + i
      live.accept(event("step.started", session))
      live.accept(event("text.started", session))
      live.accept(event("text.delta", session, "message", { delta: "x".repeat(256 * 1024) }))
    }
    expect(live.snapshot("large0").messageID).toBeNull()
    expect(live.snapshot("large16").parts[0]?.text.length).toBe(256 * 1024)
    live.clear()
    live.accept(event("step.started"))
    for (let i = 0; i < 33; i++)
      live.accept(event("reasoning.started", "session", "message", { reasoningID: "part" + i }))
    expect(live.snapshot("session").parts.length).toBe(32)
    live.accept(event("reasoning.delta", "session", "message", { reasoningID: "part0", delta: "thinking" }))
    expect(live.snapshot("session").parts[0]?.text).toBe("thinking")
    live.accept(event("reasoning.ended", "session", "message", { reasoningID: "part0" }))
    expect(live.snapshot("session").parts.length).toBe(31)
  })
  test("bounds retained sessions and clears transport-owned state", () => {
    const live = RuntimeControlLive.make()
    for (let i = 0; i < 65; i++) live.accept(event("step.started", "session" + i))
    expect(live.snapshot("session0").messageID).toBeNull()
    expect(live.snapshot("session64").messageID).toBe("message")
    live.clear()
    expect(live.snapshot("session64").messageID).toBeNull()
  })
})
