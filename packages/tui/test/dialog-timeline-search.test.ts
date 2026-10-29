import { describe, expect, test } from "bun:test"
import type { SessionMessage, TranscriptAssistantMessage } from "@miao/schema/view-models"
import { searchableMessageText } from "../src/routes/session/dialog-timeline"
import { testAssistantMessage } from "./lib/v2-message"

function assistant(content: Array<Record<string, unknown>>): SessionMessage {
  return testAssistantMessage({
    content: content as TranscriptAssistantMessage["content"],
  }) as SessionMessage
}

describe("searchableMessageText", () => {
  test("a prompt matches on its own text", () => {
    const prompt: SessionMessage = {
      id: "m1",
      type: "user",
      text: "fix the login bug",
      time: { created: 0 },
    } as SessionMessage
    expect(searchableMessageText(prompt)).toBe("fix the login bug")
  })

  test("a reply matches on its first text block", () => {
    const reply = assistant([
      { type: "reasoning", id: "r1", text: "thinking" },
      { type: "text", id: "t1", text: "the fix is in auth.ts" },
      { type: "text", id: "t2", text: "second block" },
    ])
    expect(searchableMessageText(reply)).toBe("the fix is in auth.ts")
  })

  test("a reply with no text block is not searchable", () => {
    const toolOnly = assistant([{ type: "tool", id: "tool1", name: "bash", state: { status: "completed", input: {}, structured: {}, content: [] } }])
    expect(searchableMessageText(toolOnly)).toBe("")
  })

  test("meta messages are not searchable", () => {
    const compaction: SessionMessage = {
      id: "m2",
      type: "compaction",
      reason: "auto",
      summary: "s",
      recent: "r",
      time: { created: 0 },
    } as SessionMessage
    expect(searchableMessageText(compaction)).toBe("")
  })
})
