import { describe, expect, test } from "bun:test"
import type { Event as TuiEvent } from "@miao/schema/event-view"
import type { SessionMessage } from "@miao/schema/view-models"
import { createTuiV2SessionReducer } from "../../src/context/session-v2-reducer"

const event = (input: object) => input as TuiEvent
const stamp = { timestamp: 1, sessionID: "ses_1" }
const base = {}

describe("tui v2 session reducer", () => {
  test("native deltas before any commit seed the assistant and identity keeps unknown facts unknown", () => {
    const reducer = createTuiV2SessionReducer()
    let messages: SessionMessage[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event({ ...base, ...input }))
      if (result) messages = result.messages
      return result
    }

    const seeded = apply({
      type: "session.next.text.delta",
      properties: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", delta: "hel" },
    })!
    expect(seeded.touched).toEqual(["msg_native"])
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      type: "assistant",
      agent: null,
      model: null,
      content: [{ type: "text", text: "hel" }],
    })

    apply({
      type: "session.next.text.delta",
      properties: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", delta: "lo" },
    })
    apply({
      type: "session.next.assistant.identity",
      properties: {
        ...stamp,
        assistantMessageID: "msg_native",
        assistantSeq: 5,
        provider: { protocol: "openai-chat", model: "fixture" },
        model: null,
        agent: null,
      },
    })
    apply({
      type: "session.next.text.ended",
      properties: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", text: "hello" },
    })
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      agent: null,
      model: null,
      content: [{ type: "text", text: "hello" }],
    })
  })

  test("a failing native stream settles its seeded assistant with the error", () => {
    const reducer = createTuiV2SessionReducer()
    let messages: SessionMessage[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event({ ...base, ...input }))
      if (result) messages = result.messages
      return result
    }

    apply({
      type: "session.next.text.delta",
      properties: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", delta: "partial" },
    })
    const failed = apply({
      type: "session.next.step.failed",
      properties: { ...stamp, assistantMessageID: "msg_native", error: { type: "unknown", message: "boom" } },
    })!
    expect(failed.touched).toEqual(["msg_native"])
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      finish: "error",
      error: { message: "boom" },
      time: { completed: 1 },
    })
  })
})
