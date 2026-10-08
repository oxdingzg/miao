import { describe, expect, test } from "bun:test"

import type { Part } from "@miao/schema/view-models"
import type { SessionMessageInfo } from "@/utils/server"
import { legacyContents, mergeLegacyDelta, mergeLegacyPart, removeLegacyPart } from "./legacy-part-record"

const assistant = {
  id: "msg_assistant",
  type: "assistant" as const,
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [
    { type: "text", id: "prt_text_1", text: "before" },
    {
      type: "tool",
      id: "prt_tool_1",
      name: "websearch",
      time: { created: 1 },
      state: { status: "completed", input: { query: "q" }, structured: {}, content: [{ type: "text", text: "one" }] },
    },
  ],
  time: { created: 1 },
}
const user = { id: "msg_user", type: "user" as const, text: "hi", time: { created: 0 } }
const records = [user, assistant] as unknown as SessionMessageInfo[]

const textPart = (id: string, text: string): Part => ({
  id,
  type: "text",
  sessionID: "ses",
  messageID: "msg_assistant",
  text,
})

describe("legacyContents", () => {
  test("maps text and tool parts and drops the rest", () => {
    const content = legacyContents([
      textPart("prt_text_1", "hello"),
      { id: "prt_step_1", type: "step-start", sessionID: "ses", messageID: "msg_assistant" },
      {
        id: "prt_tool_1",
        type: "tool",
        sessionID: "ses",
        messageID: "msg_assistant",
        callID: "call_1",
        tool: "bash",
        state: { status: "error", input: {}, error: "boom", metadata: {}, time: { start: 1, end: 2 } },
      },
    ])
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: "text", id: "prt_text_1", text: "hello" })
    expect(content[1]).toMatchObject({ type: "tool", id: "prt_tool_1" })
    if (content[1]?.type === "tool" && content[1].state.status === "error")
      expect(content[1].state.error).toMatchObject({ message: "boom" })
    else throw new Error("tool part not error")
  })
})

describe("mergeLegacyPart", () => {
  test("replaces the matching record content item in place", () => {
    const next = mergeLegacyPart(records, {
      id: "prt_tool_1",
      type: "tool",
      sessionID: "ses",
      messageID: "msg_assistant",
      callID: "call_1",
      tool: "websearch",
      state: {
        status: "completed",
        input: { query: "q" },
        metadata: {},
        output: "one\ntwo",
        title: "websearch",
        time: { start: 1, end: 2 },
      },
    })
    const message = next.find((item) => item.id === "msg_assistant")
    expect(message).toBeDefined()
    const tool = message!.type === "assistant" ? message!.content.find((item) => item.id === "prt_tool_1") : undefined
    expect(tool).toBeDefined()
    if (tool?.type === "tool" && tool.state.status === "completed")
      expect(tool.state.content).toEqual([{ type: "text", text: "one\ntwo" }])
    else throw new Error("tool part not completed")
  })

  test("appends unknown parts and leaves non-assistant messages alone", () => {
    const next = mergeLegacyPart(records, textPart("prt_text_new", "later"))
    const message = next.find((item) => item.id === "msg_assistant")
    expect(message!.type === "assistant" && message!.content.at(-1)).toMatchObject({ id: "prt_text_new", text: "later" })
    expect(
      mergeLegacyPart(records, { ...textPart("prt_x", "x"), messageID: "msg_missing" }),
    ).toEqual(records)
  })
})

describe("removeLegacyPart", () => {
  test("drops the matching content item", () => {
    const next = removeLegacyPart(records, "msg_assistant", "prt_text_1")
    const message = next.find((item) => item.id === "msg_assistant")
    expect(message!.type === "assistant" && message!.content.some((item) => item.id === "prt_text_1")).toBe(false)
  })

  test("keeps the records untouched for unknown parts or messages", () => {
    expect(removeLegacyPart(records, "msg_assistant", "prt_absent")).toEqual(records)
    expect(removeLegacyPart(records, "msg_user", "prt_text_1")).toEqual(records)
  })
})

describe("mergeLegacyDelta", () => {
  test("appends the delta to the matching text content", () => {
    const next = mergeLegacyDelta(records, "msg_assistant", "prt_text_1", "text", " after")
    const message = next.find((item) => item.id === "msg_assistant")
    expect(message!.type === "assistant" && message!.content.find((item) => item.id === "prt_text_1")).toMatchObject({
      text: "before after",
    })
  })

  test("creates the content item on the first delta and ignores unknown fields", () => {
    const created = mergeLegacyDelta(records, "msg_assistant", "prt_text_new", "text", "stream")
    expect(created.find((item) => item.id === "msg_assistant")!.type === "assistant").toBe(true)
    expect(mergeLegacyDelta(records, "msg_assistant", "prt_text_1", "unknown", "x")).toEqual(records)
  })
})
