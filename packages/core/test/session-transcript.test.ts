import { expect, test } from "bun:test"
import { SessionTranscript } from "../src/session/transcript"

const sessionID = "ses_native_transcript"
const assistantMessageID = "msg_native_transcript"

test("final native text and reasoning create parts without live start fragments", () => {
  const reducer = SessionTranscript.create()
  const text = reducer.reduce([], {
    id: "evt_text",
    type: "session.next.text.ended",
    properties: { sessionID, assistantMessageID, timestamp: 10, textID: "text-part", text: "restored text" },
  })
  if (!text) throw new Error("final text must project")
  const reasoning = reducer.reduce(text.messages, {
    id: "evt_reasoning",
    type: "session.next.reasoning.ended",
    properties: {
      sessionID,
      assistantMessageID,
      timestamp: 11,
      reasoningID: "reasoning-part",
      text: "restored reasoning",
    },
  })
  if (!reasoning) throw new Error("final reasoning must project")
  const assistant = reasoning.messages[0]
  if (assistant.type !== "assistant") throw new Error("expected assistant")
  expect(assistant.agent).toBeNull()
  expect(assistant.model).toBeNull()
  expect(assistant.content.map((part) => part.type)).toEqual(["text", "reasoning"])
  expect(assistant.content[0]).toMatchObject({ id: "text-part", text: "restored text" })
  expect(assistant.content[1]).toMatchObject({ id: "reasoning-part", text: "restored reasoning" })
  const repeated = reducer.reduce(reasoning.messages, {
    id: "evt_repeat",
    type: "session.next.text.ended",
    properties: { sessionID, assistantMessageID, timestamp: 12, textID: "text-part", text: "final text" },
  })
  if (!repeated) throw new Error("repeated final boundary must project")
  const updated = repeated.messages[0]
  if (updated.type !== "assistant") throw new Error("expected assistant")
  expect(updated.content).toHaveLength(2)
  expect(updated.content[0]).toMatchObject({ id: "text-part", text: "final text" })
})

test("called and settled tools restore without input stream fragments", () => {
  const reducer = SessionTranscript.create()
  const called = reducer.reduce([], {
    id: "evt_call",
    type: "session.next.tool.called",
    properties: {
      sessionID,
      assistantMessageID,
      timestamp: 20,
      callID: "read-call",
      tool: "read",
      input: { path: "file" },
      provider: { executed: false },
    },
  })
  if (!called) throw new Error("committed tool must create its part")
  const settled = reducer.reduce(called.messages, {
    id: "evt_result",
    type: "session.next.tool.success",
    properties: {
      sessionID,
      assistantMessageID,
      timestamp: 21,
      callID: "read-call",
      structured: {},
      content: [{ type: "text", text: "file contents" }],
      provider: { executed: false },
    },
  })
  if (!settled) throw new Error("tool result must project")
  const assistant = settled.messages[0]
  if (assistant.type !== "assistant") throw new Error("expected assistant")
  expect(assistant.content).toHaveLength(1)
  const tool = assistant.content[0]
  if (tool.type !== "tool") throw new Error("expected tool part")
  expect(tool.state).toMatchObject({
    status: "completed",
    input: { path: "file" },
    content: [{ type: "text", text: "file contents" }],
  })
})

test("sending-time budget survives transient projection, settlement, and replayed starts", () => {
  const reducer = SessionTranscript.create()
  const properties = {
    sessionID,
    assistantMessageID,
    timestamp: 10,
    agent: "build",
    model: { providerID: "test", id: "model" },
    contextBudget: { input: 50_000, source: "estimated" as const, window: 100_000, limit: 70_000 },
  }
  const started = reducer.reduce([], { id: "evt_budget_start", type: "session.next.step.started", properties })
  expect(started?.messages[0]).toMatchObject({ contextBudget: properties.contextBudget })
  const failed = reducer.reduce(started?.messages ?? [], {
    id: "evt_budget_failed",
    type: "session.next.step.failed",
    properties: {
      sessionID,
      assistantMessageID,
      timestamp: 11,
      error: { type: "unknown", message: "prompt too long" },
    },
  })
  expect(failed?.messages[0]).toMatchObject({ contextBudget: properties.contextBudget, finish: "error" })
  const restarted = reducer.reduce(failed?.messages ?? [], {
    id: "evt_budget_restart",
    type: "session.next.step.started",
    properties: { ...properties, contextBudget: { ...properties.contextBudget, input: 20_000 } },
  })
  expect(restarted?.messages).toHaveLength(1)
  expect(restarted?.messages[0]).toMatchObject({ contextBudget: { input: 20_000 }, error: undefined })
})

test("synthetic pause metadata survives transcript projection and duplicate replay", () => {
  const reducer = SessionTranscript.create()
  const event = {
    id: "evt_paused",
    type: "session.next.synthetic" as const,
    properties: {
      sessionID,
      messageID: "msg_paused",
      timestamp: 50,
      text: "Task paused. Send a message to continue.",
      metadata: { source: "engine", notificationPause: true },
    },
  }
  const result = reducer.reduce([], event)
  expect(result?.messages[0]).toMatchObject({ type: "synthetic", metadata: event.properties.metadata })
  expect(reducer.reduce(result!.messages, event)?.messages).toEqual(result!.messages)
})
