import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@/utils/server"
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
    const settled = messages
    apply({
      ...base,
      id: "evt_retry",
      type: "session.next.retried",
      data: { ...stamp, attempt: 2, error: { message: "retry", isRetryable: true } },
    })

    // Retries surface through the session status, so the projected messages stay as they were.
    expect(messages).toEqual(settled)
    expect(messages[0]).toMatchObject({
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "call_1",
          provider: { executed: true },
          state: { status: "completed", structured: {}, content: [{ text: "done" }] },
        },
      ],
    })
  })

  test("settles pending tools as failed when the step fails", () => {
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
      id: "evt_pending",
      type: "session.next.tool.input.started",
      data: { ...stamp, assistantMessageID: "msg_assistant", callID: "call_pending", name: "read" },
    })
    apply({
      ...base,
      id: "evt_fail",
      type: "session.next.step.failed",
      data: { ...stamp, assistantMessageID: "msg_assistant", error: { type: "unknown", message: "aborted" } },
    })

    expect(messages[0]).toMatchObject({
      type: "assistant",
      finish: "error",
      content: [
        {
          type: "tool",
          id: "call_pending",
          state: { status: "error", error: { type: "unknown", message: "Interrupted" } },
        },
      ],
    })
  })
})

test("updates the original command message through preparation and failure", () => {
  const reducer = createV2SessionReducer()
  const promoted = reducer.reduce(
    [],
    event({
      ...base,
      id: "evt_command",
      type: "session.next.prompted",
      data: {
        ...stamp,
        messageID: "msg_command",
        delivery: "steer",
        prompt: { text: "raw !`echo`", command: { name: "daily", arguments: "", subtask: false } },
      },
    }),
  )
  const started = reducer.reduce(
    promoted?.messages ?? [],
    event({
      ...base,
      id: "evt_started",
      type: "session.next.command.started",
      data: { ...stamp, messageID: "msg_command" },
    }),
  )
  expect(started?.messages[0]).toMatchObject({ id: "msg_command", commandState: "running" })
  const completed = reducer.reduce(
    started?.messages ?? [],
    event({
      ...base,
      id: "evt_completed",
      type: "session.next.command.completed",
      data: { ...stamp, messageID: "msg_command", prompt: { text: "expanded output" } },
    }),
  )
  expect(completed?.touched).toEqual(["msg_command"])
  expect(completed?.messages).toHaveLength(1)
  expect(completed?.messages[0]).toMatchObject({ text: "expanded output", commandState: "completed" })
  const failed = reducer.reduce(
    started?.messages ?? [],
    event({
      ...base,
      id: "evt_failed",
      type: "session.next.command.failed",
      data: { ...stamp, messageID: "msg_command", error: "refused", text: "canonical failure text" },
    }),
  )
  expect(failed?.messages[0]).toMatchObject({
    text: "canonical failure text",
    commandState: "failed",
    commandError: "refused",
  })
})

test("discard removes only the streamed draft and preserves settled partial text", () => {
  const reducer = createV2SessionReducer()
  const settled = [
    {
      id: "msg_partial",
      type: "assistant" as const,
      agent: "build",
      model: { id: "model", providerID: "provider" },
      time: { created: 1, completed: 2 },
      content: [{ type: "text" as const, id: "text_partial", text: "saved partial" }],
    },
  ]
  const source = [
    ...settled,
    {
      id: "msg_draft",
      type: "assistant" as const,
      agent: "build",
      model: { id: "model", providerID: "provider" },
      time: { created: 3 },
      content: [],
    },
  ]
  const streamed = reducer.reduce(
    source,
    event({
      id: "evt_fragment",
      type: "session.next.text.delta",
      data: { ...stamp, assistantMessageID: "msg_draft", textID: "text_draft", delta: "temporary" },
    }),
  )!
  expect(streamed.messages).toHaveLength(2)
  const discard = event({
    id: "evt_discard",
    type: "session.next.stream.discarded",
    data: { ...stamp, assistantMessageID: "msg_draft" },
  })
  const removed = reducer.reduce(streamed.messages, discard)!
  expect(removed.messages).toEqual(settled)
  expect(removed.touched).toEqual(["msg_draft"])
  expect(reducer.reduce(removed.messages, discard)?.messages).toEqual(settled)
})

describe("native assistant initialization", () => {
  test("deltas before any commit seed the assistant and identity keeps unknown facts unknown", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    const seeded = apply({
      ...base,
      id: "evt_delta",
      type: "session.next.text.delta",
      data: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", delta: "hel" },
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
      ...base,
      id: "evt_delta_2",
      type: "session.next.text.delta",
      data: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", delta: "lo" },
    })
    apply({
      ...base,
      id: "evt_identity",
      type: "session.next.assistant.identity",
      data: {
        ...stamp,
        assistantMessageID: "msg_native",
        assistantSeq: 5,
        provider: { protocol: "openai-chat", model: "fixture" },
        model: null,
        agent: null,
      },
    })
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      agent: null,
      model: null,
      content: [{ type: "text", text: "hello" }],
    })

    apply({
      ...base,
      id: "evt_end",
      type: "session.next.text.ended",
      data: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", text: "hello world" },
    })
    expect(messages[0]).toMatchObject({ content: [{ type: "text", text: "hello world" }] })
  })

  test("a failing native stream settles its seeded assistant with the error", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_delta",
      type: "session.next.text.delta",
      data: { ...stamp, assistantMessageID: "msg_native", textID: "text_native_5_0", delta: "partial" },
    })
    const failed = apply({
      ...base,
      id: "evt_failed",
      type: "session.next.step.failed",
      data: { ...stamp, assistantMessageID: "msg_native", error: { type: "unknown", message: "boom" } },
    })!
    expect(failed.touched).toEqual(["msg_native"])
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      finish: "error",
      error: { message: "boom" },
      time: { completed: 1 },
    })
  })

  test("streams the compaction summary as a draft and settles it into the checkpoint record", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_started",
      type: "session.next.compaction.started",
      data: { ...stamp, messageID: "msg_compact", reason: "auto" },
    })
    apply({
      ...base,
      id: "evt_delta_1",
      type: "session.next.compaction.delta",
      data: { ...stamp, messageID: "msg_compact", text: "hello " },
    })
    const mid = apply({
      ...base,
      id: "evt_delta_2",
      type: "session.next.compaction.delta",
      data: { ...stamp, messageID: "msg_compact", text: "world" },
    })!
    expect(mid.messages[0]).toMatchObject({
      type: "assistant",
      agent: null,
      content: [{ type: "text", id: "msg_compact:summary", text: "hello world" }],
    })

    const ended = apply({
      ...base,
      id: "evt_ended",
      type: "session.next.compaction.ended",
      data: { ...stamp, messageID: "msg_compact", reason: "auto", text: "final summary", recent: "kept" },
    })!
    expect(ended.touched).toEqual(["msg_compact"])
    expect(ended.messages).toHaveLength(1)
    expect(ended.messages[0]).toMatchObject({ type: "compaction", summary: "final summary", recent: "kept" })

    // A late delta must never resurrect the settled checkpoint as a draft.
    const stray = apply({
      ...base,
      id: "evt_delta_3",
      type: "session.next.compaction.delta",
      data: { ...stamp, messageID: "msg_compact", text: "more" },
    })!
    expect(stray.messages).toHaveLength(1)
    expect(stray.messages[0]).toMatchObject({ type: "compaction", summary: "final summary" })
  })

  test("drops an unsettled summary draft when the drain leaves the compacting phase", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_started",
      type: "session.next.compaction.started",
      data: { ...stamp, messageID: "msg_compact", reason: "auto" },
    })
    apply({
      ...base,
      id: "evt_delta",
      type: "session.next.compaction.delta",
      data: { ...stamp, messageID: "msg_compact", text: "partial" },
    })
    // Still compacting: the draft stays.
    const compacting = apply({
      ...base,
      id: "evt_status_busy",
      type: "session.next.status",
      data: { ...stamp, status: { type: "busy", phase: "compacting" } },
    })
    expect(compacting).toBeUndefined()
    expect(messages).toHaveLength(1)

    // A failed summary never publishes `ended`; the next phase drops the draft.
    const dropped = apply({
      ...base,
      id: "evt_status_requesting",
      type: "session.next.status",
      data: { ...stamp, status: { type: "busy", phase: "requesting" } },
    })!
    expect(dropped.touched).toEqual(["msg_compact"])
    expect(dropped.messages).toEqual([])

    // Nothing unsettled remains, so later statuses reduce to nothing.
    expect(
      reducer.reduce(dropped.messages, event({
        ...base,
        id: "evt_status_idle",
        type: "session.next.status",
        data: { ...stamp, status: { type: "idle" } },
      })),
    ).toBeUndefined()
  })

  test("keeps the settled checkpoint through a phase change that follows `ended`", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_started",
      type: "session.next.compaction.started",
      data: { ...stamp, messageID: "msg_compact", reason: "auto" },
    })
    apply({
      ...base,
      id: "evt_ended",
      type: "session.next.compaction.ended",
      data: { ...stamp, messageID: "msg_compact", reason: "auto", text: "summary", recent: "kept" },
    })
    expect(
      apply({
        ...base,
        id: "evt_status_idle",
        type: "session.next.status",
        data: { ...stamp, status: { type: "idle" } },
      }),
    ).toBeUndefined()
    expect(messages[0]).toMatchObject({ type: "compaction", summary: "summary" })
  })

  test("ended without started appends the settled checkpoint record", () => {
    const reducer = createV2SessionReducer()
    const ended = reducer.reduce(
      [],
      event({
        ...base,
        id: "evt_ended",
        type: "session.next.compaction.ended",
        data: { ...stamp, messageID: "msg_compact", reason: "manual", text: "summary", recent: "" },
      }),
    )!
    expect(ended.messages).toHaveLength(1)
    expect(ended.messages[0]).toMatchObject({ type: "compaction", summary: "summary", reason: "manual" })
  })
})

describe("native drain failure", () => {
  test("settles the streamed draft and its pending tools when the drain fails", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_delta",
      type: "session.next.text.delta",
      data: { ...stamp, assistantMessageID: "msg_native", textID: "text_5_0", delta: "partial" },
    })
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.next.tool.input.started",
      data: { ...stamp, assistantMessageID: "msg_native", callID: "call_1", name: "bash" },
    })
    const failed = apply({
      ...base,
      id: "evt_failed",
      type: "session.next.failed",
      data: {
        ...stamp,
        error: { type: "unknown", message: "engine drain failed" },
        name: "EngineRunFailed",
      },
    })!
    expect(failed.touched).toEqual(["msg_native"])
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      type: "assistant",
      finish: "error",
      error: { type: "unknown", message: "engine drain failed" },
      time: { created: 1, completed: 1 },
      content: [
        { type: "text", text: "partial" },
        {
          type: "tool",
          id: "call_1",
          state: {
            status: "error",
            input: {},
            error: { type: "unknown", message: "Interrupted" },
            time: { created: 1, ran: 1, completed: 1 },
          },
        },
      ],
    })

    // The drain is over; a duplicate failure has nothing left to settle.
    expect(
      reducer.reduce(messages, event({
        ...base,
        id: "evt_failed_2",
        type: "session.next.failed",
        data: { ...stamp, error: { type: "unknown", message: "again" }, name: "EngineRunFailed" },
      })),
    ).toBeUndefined()
  })

  test("reduces to nothing when no assistant is unsettled", () => {
    const reducer = createV2SessionReducer()
    expect(
      reducer.reduce([], event({
        ...base,
        id: "evt_failed",
        type: "session.next.failed",
        data: { ...stamp, error: { type: "unknown", message: "engine drain failed" } },
      })),
    ).toBeUndefined()
    const settled = [
      {
        id: "msg_done",
        type: "assistant" as const,
        agent: null,
        model: null,
        time: { created: 1, completed: 2 },
        content: [],
      },
    ]
    const result = reducer.reduce(settled, event({
      ...base,
      id: "evt_failed",
      type: "session.next.failed",
      data: { ...stamp, error: { type: "unknown", message: "engine drain failed" } },
    }))
    expect(result).toBeUndefined()
  })

  test("failed settles the newest unsettled assistant, not settled history", () => {
    const reducer = createV2SessionReducer()
    const source = [
      {
        id: "msg_old",
        type: "assistant" as const,
        agent: null,
        model: null,
        time: { created: 1, completed: 2 },
        content: [],
      },
    ]
    const streamed = reducer.reduce(
      source,
      event({
        ...base,
        id: "evt_delta",
        type: "session.next.text.delta",
        data: { ...stamp, assistantMessageID: "msg_new", textID: "text_9_0", delta: "draft" },
      }),
    )!
    const failed = reducer.reduce(streamed.messages, event({
      ...base,
      id: "evt_failed",
      type: "session.next.failed",
      data: { ...stamp, timestamp: 3, error: { type: "unknown", message: "boom" } },
    }))!
    expect(failed.touched).toEqual(["msg_new"])
    expect(failed.messages[0]).toMatchObject({ id: "msg_old", time: { created: 1, completed: 2 } })
    expect(failed.messages[1]).toMatchObject({ id: "msg_new", finish: "error", time: { completed: 3 } })
  })
})

describe("native commit projection without identity evidence", () => {
  test("a tool-only commit seeds the assistant and completes through tool.success", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    const called = apply({
      ...base,
      id: "evt_called",
      type: "session.next.tool.called",
      data: {
        ...stamp,
        assistantMessageID: "msg_native",
        callID: "call_1",
        tool: "bash",
        input: { command: "echo hi" },
        provider: { executed: false },
      },
    })!
    expect(called.touched).toEqual(["msg_native"])
    expect(messages[0]).toMatchObject({
      id: "msg_native",
      type: "assistant",
      agent: null,
      model: null,
      content: [
        {
          type: "tool",
          id: "call_1",
          state: { status: "running", input: { command: "echo hi" } },
        },
      ],
    })

    const success = apply({
      ...base,
      id: "evt_success",
      type: "session.next.tool.success",
      data: {
        ...stamp,
        assistantMessageID: "msg_native",
        callID: "call_1",
        structured: {},
        content: [{ type: "text", text: "hi" }],
        provider: { executed: false },
      },
    })!
    expect(success.touched).toEqual(["msg_native"])
    expect(messages[0]).toMatchObject({
      content: [{ type: "tool", id: "call_1", state: { status: "completed", content: [{ text: "hi" }] } }],
    })
  })

  test("step.ended settles a commit that streamed nothing", () => {
    const reducer = createV2SessionReducer()
    const ended = reducer.reduce([], event({
      ...base,
      id: "evt_ended",
      type: "session.next.step.ended",
      data: {
        ...stamp,
        assistantMessageID: "msg_native",
        finish: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }))!
    expect(ended.touched).toEqual(["msg_native"])
    expect(ended.messages[0]).toMatchObject({
      id: "msg_native",
      type: "assistant",
      agent: null,
      model: null,
      finish: "stop",
      cost: 0.01,
      tokens: { input: 10, output: 5 },
      time: { created: 1, completed: 1 },
    })
  })
})
