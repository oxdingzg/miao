import { describe, expect, test } from "bun:test"
import { SessionFork } from "@miao/core/session/fork"

describe("SessionFork.remapEventData", () => {
  test("rewrites message-scoped ids and preserves everything else", () => {
    const input = {
      sessionID: "ses_source",
      messageID: "msg_1",
      assistantMessageID: "msg_2",
      nested: { callID: "call_1", textID: "text_1", command: "echo hi" },
      items: [{ reasoningID: "reason_1" }, { untouched: "msg_1" }],
    }
    const seen = new Map<string, string>()
    const output = SessionFork.remapEventData(input, (old) => {
      const existing = seen.get(old)
      if (existing) return existing
      const next = `new_${seen.size}`
      seen.set(old, next)
      return next
    }) as Record<string, unknown>

    expect(output.sessionID).toBe("ses_source")
    expect(output.messageID).toBe("new_0")
    expect(output.assistantMessageID).toBe("new_1")
    expect(output.nested).toMatchObject({ callID: "new_2", textID: "new_3", command: "echo hi" })
    expect(output.items).toMatchObject([{ reasoningID: "new_4" }, { untouched: "msg_1" }])
  })

  test("does not mutate the input", () => {
    const input = { messageID: "msg_1" }
    SessionFork.remapEventData(input, () => "msg_new")
    expect(input.messageID).toBe("msg_1")
  })
})
