import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import { createV2SessionReducer } from "./server-session-v2-reducer"

const event = (input: object) => input as OpenCodeEventEncoded
const base = { location: { directory: "/repo" }, durable: { aggregateID: "ses_1", seq: 1, version: 1 } }
const stamp = { timestamp: 1, sessionID: "ses_1" }
const model = { id: "model", providerID: "provider" }

describe("v2 session reducer", () => {
  test("continues existing streams and appends new streams after loading history", () => {
    const reducer = createV2SessionReducer()
    const source = [
      {
        id: "msg_assistant",
        type: "assistant" as const,
        agent: "build",
        model,
        time: { created: 1 },
        content: [{ type: "text" as const, id: "txt_existing", text: "loaded" }],
      },
    ]
    const continued = reducer.reduce(
      source,
      event({
        ...base,
        id: "evt_existing",
        type: "session.next.text.delta",
        data: { ...stamp, assistantMessageID: "msg_assistant", textID: "txt_existing", delta: " history" },
      }),
    )!
    const started = reducer.reduce(
      continued.messages,
      event({
        ...base,
        id: "evt_new",
        type: "session.next.text.started",
        data: { ...stamp, assistantMessageID: "msg_assistant", textID: "txt_new" },
      }),
    )!
    const ended = reducer.reduce(
      started.messages,
      event({
        ...base,
        id: "evt_end",
        type: "session.next.text.ended",
        data: { ...stamp, assistantMessageID: "msg_assistant", textID: "txt_new", text: "new text" },
      }),
    )!
    expect(ended.messages[0]).toMatchObject({ content: [{ text: "loaded history" }, { text: "new text" }] })
  })

  test("projects a prompted input and streaming assistant content", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_prompted",
      type: "session.next.prompted",
      data: { ...stamp, messageID: "msg_user", prompt: { text: "hello" }, delivery: "steer" },
    })
    apply({
      ...base,
      id: "evt_step",
      type: "session.next.step.started",
      data: { ...stamp, assistantMessageID: "msg_assistant", agent: "build", model },
    })
    apply({
      ...base,
      id: "evt_text_start",
      type: "session.next.text.started",
      data: { ...stamp, assistantMessageID: "msg_assistant", textID: "txt_1" },
    })
    apply({
      ...base,
      id: "evt_text_delta",
      type: "session.next.text.delta",
      data: { ...stamp, assistantMessageID: "msg_assistant", textID: "txt_1", delta: "hel" },
    })
    apply({
      ...base,
      id: "evt_text_end",
      type: "session.next.text.ended",
      data: { ...stamp, assistantMessageID: "msg_assistant", textID: "txt_1", text: "hello" },
    })

    expect(messages[0]).toMatchObject({ id: "msg_user", type: "user", text: "hello" })
    expect(messages[1]).toMatchObject({
      id: "msg_assistant",
      type: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
  })

  test("addresses each text stream by its own id", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
    }

    apply({
      ...base,
      id: "evt_step",
      type: "session.next.step.started",
      data: { ...stamp, assistantMessageID: "msg_assistant", agent: "build", model },
    })
    for (const [id, textID] of [
      ["evt_a0", "txt_a"],
      ["evt_b0", "txt_b"],
    ] as const)
      apply({
        ...base,
        id,
        type: "session.next.text.started",
        data: { ...stamp, assistantMessageID: "msg_assistant", textID },
      })
    for (const [id, textID, delta] of [
      ["evt_a1", "txt_a", "one "],
      ["evt_b1", "txt_b", "two "],
      ["evt_a2", "txt_a", "more"],
    ] as const)
      apply({
        ...base,
        id,
        type: "session.next.text.delta",
        data: { ...stamp, assistantMessageID: "msg_assistant", textID, delta },
      })

    expect(messages[0]).toMatchObject({
      content: [
        { type: "text", text: "one more" },
        { type: "text", text: "two " },
      ],
    })
  })

  test("folds tool, retry, and completion events", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
    }

    apply({
      ...base,
      id: "evt_step",
      type: "session.next.step.started",
      data: { ...stamp, assistantMessageID: "msg_assistant", agent: "build", model },
    })
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.next.tool.input.started",
      data: { ...stamp, assistantMessageID: "msg_assistant", callID: "call_1", name: "bash" },
    })
    apply({
      ...base,
      id: "evt_tool_delta",
      type: "session.next.tool.input.delta",
      data: { ...stamp, assistantMessageID: "msg_assistant", callID: "call_1", delta: "{}" },
    })
    apply({
      ...base,
      id: "evt_tool_called",
      type: "session.next.tool.called",
      data: {
        ...stamp,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        tool: "bash",
        input: {},
        provider: { executed: true },
      },
    })
    apply({
      ...base,
      id: "evt_tool_success",
      type: "session.next.tool.success",
      data: {
        ...stamp,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        structured: {},
        content: [{ type: "text", text: "done" }],
        provider: { executed: true },
      },
    })
    apply({
      ...base,
      id: "evt_retry",
      type: "session.next.retried",
      data: { ...stamp, attempt: 2, error: { message: "retry", isRetryable: true } },
    })

    expect(messages[0]).toMatchObject({
      type: "assistant",
      retry: { attempt: 2, at: 1, error: { type: "retry", message: "retry" } },
      content: [{ type: "tool", id: "call_1", state: { status: "completed", content: [{ text: "done" }] } }],
    })
  })
})
