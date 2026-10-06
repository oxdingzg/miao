/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DiagnosticMetrics } from "@miao/core/diagnostic-metrics"
import type { GlobalEvent } from "../../../../src/context/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_v2_incremental"

// V2 transcript: parts live inline on the message. This helper mirrors the old
// part-store lookups the tests were written against.
function partsOf(
  sync: {
    data: {
      message: Record<
        string,
        ReadonlyArray<{ id: string; type: string; text?: string; content?: ReadonlyArray<unknown> }>
      >
    }
  },
  messageID: string,
): ReadonlyArray<Record<string, unknown>> | undefined {
  const message = sync.data.message[sessionID]?.find((item) => item.id === messageID)
  if (!message) return undefined
  if (message.type === "assistant") return message.content as ReadonlyArray<Record<string, unknown>>
  if (message.type === "user")
    return [{ type: "text", id: `${messageID}-text`, text: message.text }]
  return undefined
}
const userID = "msg_v2_incremental_user"
const messageID = "msg_v2_incremental_assistant"
const textID = "prt_v2_incremental_text"
const toolID = "call_v2_incremental"
const SEED_COUNT = 400

const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "v2 incremental",
  agent: "build",
  model: { id: "model", providerID: "test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory },
  subpath: "",
}

// A long transcript so the test measures the per-event cost, not the empty case.
function seedMessages() {
  return Array.from({ length: SEED_COUNT }, (_, index) => ({
    id: `msg_seed_${String(index).padStart(3, "0")}`,
    type: "assistant" as const,
    time: { created: index + 1 },
    agent: "build",
    model: { id: "model", providerID: "test" },
    content: [{ type: "text" as const, id: `prt_seed_${index}`, text: `seed ${index}` }],
  }))
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function hydrationCount() {
  const entry = DiagnosticMetrics.snapshot().find((item) => item.name === "tui.sync")
  const value = entry?.value as { hydration?: { count?: number } } | null | undefined
  return value?.hydration?.count ?? 0
}

for (const type of ["text", "reasoning"] as const) {
  test(`a history snapshot ahead of queued ${type} fragments does not duplicate visible text`, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let app: Awaited<ReturnType<typeof mount>>["app"] | undefined
    try {
      const mounted = await mount((url) => {
        if (url.pathname === "/api/session") return json({ data: [session] })
        if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
        if (url.pathname === `/api/session/${sessionID}/context`)
          return json({
            data: [
              {
                id: messageID,
                type: "assistant",
                agent: "build",
                model: session.model,
                time: { created: 1 },
                content: [{ type, id: textID, text: "你好Swissquote" }],
              },
            ],
          })
        if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
        if (url.pathname === `/api/session/${sessionID}/todo` || url.pathname === `/api/session/${sessionID}/diff`)
          return json({ data: [] })
        if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "idle" } })
        return undefined
      }, tmp.path)
      app = mounted.app
      await mounted.sync.session.sync(sessionID)
      mounted.emit(
        global(
          type === "text"
            ? {
                id: "evt_snapshot_start",
                type: "session.next.text.started",
                properties: { timestamp: 2, sessionID, assistantMessageID: messageID, textID },
              }
            : {
                id: "evt_snapshot_start",
                type: "session.next.reasoning.started",
                properties: { timestamp: 2, sessionID, assistantMessageID: messageID, reasoningID: textID },
              },
        ),
      )
      for (const [index, delta] of ["你", "好", "Swiss", "quote"].entries())
        mounted.emit(
          global(
            type === "text"
              ? {
                  id: `evt_snapshot_delta_${index}`,
                  type: "session.next.text.delta",
                  properties: { timestamp: index + 3, sessionID, assistantMessageID: messageID, textID, delta },
                }
              : {
                  id: `evt_snapshot_delta_${index}`,
                  type: "session.next.reasoning.delta",
                  properties: {
                    timestamp: index + 3,
                    sessionID,
                    assistantMessageID: messageID,
                    reasoningID: textID,
                    delta,
                  },
                },
          ),
        )
      // This marker is dispatched after the queued deltas, avoiding a timing sleep.
      mounted.emit(
        global({
          id: "evt_snapshot_status",
          type: "session.next.status",
          properties: { timestamp: 7, sessionID, status: { type: "busy" } },
        }),
      )
      await wait(() => mounted.sync.data.session_status[sessionID]?.type === "busy")
      expect(partsOf(mounted.sync, messageID)![0]).toMatchObject({ type, text: "你好Swissquote" })
      // The ended payload is authoritative even when it is a shorter prefix.
      mounted.emit(
        global(
          type === "text"
            ? {
                id: "evt_snapshot_end",
                type: "session.next.text.ended",
                properties: { timestamp: 8, sessionID, assistantMessageID: messageID, textID, text: "你好Swiss" },
              }
            : {
                id: "evt_snapshot_end",
                type: "session.next.reasoning.ended",
                properties: {
                  timestamp: 8,
                  sessionID,
                  assistantMessageID: messageID,
                  reasoningID: textID,
                  text: "你好Swiss",
                },
              },
        ),
      )
      await wait(() => {
        const part = partsOf(mounted.sync, messageID)![0]
        return (part.type === "text" || part.type === "reasoning") && part.text === "你好Swiss"
      })
      expect(partsOf(mounted.sync, messageID)![0]).toMatchObject({ type, text: "你好Swiss" })
      if (type === "reasoning")
        expect(partsOf(mounted.sync, messageID)![0]).toMatchObject({ time: { completed: 8 } })
    } finally {
      app?.renderer.destroy()
    }
  })
}

test("a durable-event burst on a long transcript applies incrementally without re-hydrating", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let contextRequests = 0
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined

  try {
    const mounted = await mount((url) => {
      if (url.pathname === "/api/session") return json({ data: [session] })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/context`) {
        contextRequests += 1
        return json({ data: seedMessages() })
      }
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/todo` || url.pathname === `/api/session/${sessionID}/diff`)
        return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "idle" } })
      return undefined
    }, tmp.path)
    app = mounted.app

    await mounted.sync.session.sync(sessionID)
    const hydrated = contextRequests
    const hydrationAtStart = hydrationCount()
    expect(hydrated).toBe(1)
    expect(mounted.sync.data.message[sessionID]).toHaveLength(SEED_COUNT)
    // The resident window caps at MAX_RESIDENT_MESSAGES in sync.tsx; the burst
    // below pushes past it, so the head must roll off while the tail stays.
    const MAX_RESIDENT = 400
    const oldestResident = mounted.sync.data.message[sessionID][0]?.id

    const events: GlobalEvent["payload"][] = [
      {
        id: "evt_prompted",
        type: "session.next.prompted",
        properties: { timestamp: 10_001, sessionID, messageID: userID, prompt: { text: "hi" }, delivery: "steer" },
      },
      {
        id: "evt_step",
        type: "session.next.step.started",
        properties: {
          timestamp: 10_002,
          sessionID,
          assistantMessageID: messageID,
          agent: "build",
          model: session.model,
        },
      },
      {
        id: "evt_text_start",
        type: "session.next.text.started",
        properties: { timestamp: 10_003, sessionID, assistantMessageID: messageID, textID },
      },
      {
        id: "evt_text_delta",
        type: "session.next.text.delta",
        properties: { timestamp: 10_004, sessionID, assistantMessageID: messageID, textID, delta: " world" },
      },
      {
        id: "evt_text_end",
        type: "session.next.text.ended",
        properties: { timestamp: 10_005, sessionID, assistantMessageID: messageID, textID, text: "hello world" },
      },
      {
        id: "evt_reasoning_start",
        type: "session.next.reasoning.started",
        properties: { timestamp: 10_006, sessionID, assistantMessageID: messageID, reasoningID: "prt_reasoning" },
      },
      {
        id: "evt_reasoning_end",
        type: "session.next.reasoning.ended",
        properties: {
          timestamp: 10_007,
          sessionID,
          assistantMessageID: messageID,
          reasoningID: "prt_reasoning",
          text: "thinking",
        },
      },
      {
        id: "evt_tool_start",
        type: "session.next.tool.input.started",
        properties: { timestamp: 10_008, sessionID, assistantMessageID: messageID, callID: toolID, name: "bash" },
      },
      {
        id: "evt_tool_called",
        type: "session.next.tool.called",
        properties: {
          timestamp: 10_009,
          sessionID,
          assistantMessageID: messageID,
          callID: toolID,
          tool: "bash",
          input: { command: "echo done" },
          provider: { executed: true },
        },
      },
      {
        id: "evt_tool_success",
        type: "session.next.tool.success",
        properties: {
          timestamp: 10_010,
          sessionID,
          assistantMessageID: messageID,
          callID: toolID,
          structured: {},
          content: [{ type: "text", text: "done" }],
          provider: { executed: true },
        },
      },
      {
        id: "evt_step_end",
        type: "session.next.step.ended",
        properties: {
          timestamp: 10_011,
          sessionID,
          assistantMessageID: messageID,
          finish: "stop",
          cost: 0.01,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    ]

    for (const event of events) mounted.emit(global(event))

    await wait(() => {
      const messages = mounted.sync.data.message[sessionID] ?? []
      const parts = partsOf(mounted.sync, messageID) ?? []
      return (
        messages.length === MAX_RESIDENT &&
        messages[0]?.id !== oldestResident &&
        parts.length === 3 &&
        parts[0]?.type === "text" &&
        parts[0].text === "hello world" &&
        parts[1]?.type === "reasoning" &&
        parts[2]?.type === "tool" &&
        (parts[2] as { state?: { status?: string } }).state?.status === "completed"
      )
    })

    const infos = mounted.sync.data.message[sessionID] ?? []
    expect(infos.slice(-2).map((message) => message.id)).toEqual([userID, messageID])
    expect(infos.at(-1)).toMatchObject({ id: messageID, type: "assistant", finish: "stop", cost: 0.01 })
    expect(partsOf(mounted.sync, messageID)![0]).toMatchObject({ type: "text", text: "hello world" })
    expect(partsOf(mounted.sync, messageID)![2]).toEqual({
      type: "tool",
      id: "call_v2_incremental",
      name: "bash",
      time: { created: 10_008, ran: 10_009, completed: 10_010 },
      provider: { executed: true },
      state: {
        status: "completed",
        input: { command: "echo done" },
        structured: {},
        content: [{ type: "text", text: "done" }],
      },
    })

    // Every durable event above was folded in place: no context refetch and no
    // additional hydration beyond the initial sync, despite the long transcript.
    // The resident window stayed capped while the tail kept updating.
    expect(contextRequests).toBe(hydrated)
    expect(hydrationCount()).toBe(hydrationAtStart)
  } finally {
    app?.renderer.destroy()
  }
})
