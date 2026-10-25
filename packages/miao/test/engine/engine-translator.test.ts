import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@miao/schema/model"
import { EngineTranslator, type EngineSessionEvent } from "@/engine/session"
import { messageID } from "@/engine/identity"

const collect = () => {
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator((event) => outputs.push(event))
  return { outputs, translator }
}

test("journal replay translates committed assistant text with per-event provenance", () => {
  const { outputs, translator } = collect()
  translator.dispatch({
    session_id: "ses_replay",
    seq: 7,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "text", text: "persisted" }] },
    recorded_at_ms: 420,
  })
  expect(outputs).toHaveLength(2)
  expect(outputs[0].type).toBe("session.next.text.ended")
  expect(outputs[0].source).toEqual({ sessionID: "ses_replay", seq: 7, index: 0, recordedAtMs: 420 })
  const data = outputs[0].data as { text?: unknown }
  expect(data.text).toBe("persisted")
  // The assistant settlement trails its own text events and carries the
  // step's usage evidence (zeroed when the journal recorded no usage).
  expect(outputs[1].type).toBe("session.next.step.ended")
  // The settlement publishes after the text events, so its source ordinal is 1.
  expect(outputs[1].source).toEqual({ sessionID: "ses_replay", seq: 7, index: 1, recordedAtMs: 420 })
  const settlement = outputs[1].data as {
    assistantMessageID?: unknown
    finish?: unknown
    cost?: unknown
    tokens?: { input?: unknown }
    ttft?: unknown
  }
  expect(settlement.assistantMessageID).toBe(messageID("ses_replay", 7))
  expect(settlement.finish).toBe("stop")
  expect(settlement.cost).toBe(0)
  expect(settlement.tokens?.input).toBe(0)
  expect(settlement.ttft).toBeUndefined()
})

test("assistant identity resolves the product model through pricing and keeps the engine's agent", () => {
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator(
    (event) => outputs.push(event),
    (id) => {
      if (id !== "actual") return
      return {
        model: Schema.decodeUnknownSync(Model.Ref)({ providerID: "catalog", id }),
        cost: [{ input: 1000, output: 2000, cache: { read: 100, write: 1000 } }],
      }
    },
  )
  translator.dispatch({
    session_id: "ses_identity",
    seq: 9,
    kind: "assistant.identity",
    data: { assistant_seq: 7, provider: { protocol: "openai-chat", model: "actual" }, agent: "explore" },
    recorded_at_ms: 500,
  })
  const identity = outputs.find((event) => event.type === "session.next.assistant.identity")
  expect(identity?.data).toMatchObject({
    agent: "explore",
    model: { providerID: "catalog", id: "actual" },
  })
})

test("unrelated journal kinds produce no product events and engine vocabulary stays engine-side", () => {
  const { outputs, translator } = collect()
  translator.dispatch({ session_id: "ses_replay", seq: 8, kind: "context.changed", data: { epoch: 1 } })
  translator.dispatch({ session_id: "ses_replay", seq: 9, kind: "input.promoted", data: { input_id: "in_1" } })
  expect(outputs).toEqual([])
})

test.each([
  { name: "null usage model", usageModel: null, run: "run", step: 0, recorded: true, expected: "priced" },
  { name: "missing usage model", usageModel: undefined, run: "run", step: 0, recorded: true, expected: "priced" },
  { name: "explicit model wins", usageModel: "explicit", run: "run", step: 0, recorded: true, expected: "explicit" },
  {
    name: "unknown explicit model stays unknown",
    usageModel: "unknown",
    run: "run",
    step: 0,
    recorded: true,
    expected: undefined,
  },
  {
    name: "different run cannot borrow identity",
    usageModel: null,
    run: "other",
    step: 0,
    recorded: true,
    expected: undefined,
  },
  {
    name: "different step cannot borrow identity",
    usageModel: null,
    run: "run",
    step: 1,
    recorded: true,
    expected: undefined,
  },
  {
    name: "unrecorded identity cannot price history",
    usageModel: null,
    run: "run",
    step: 0,
    recorded: false,
    expected: undefined,
  },
])("step pricing from recorded provider identity: $name", (row) => {
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator(
    (event) => outputs.push(event),
    (id) => {
      if (id !== "priced" && id !== "explicit") return
      return {
        model: Schema.decodeUnknownSync(Model.Ref)({ providerID: "catalog", id }),
        cost: [{ input: 1000, output: 2000, cache: { read: 100, write: 1000 } }],
      }
    },
  )
  translator.dispatch({
    session_id: "ses_priced",
    seq: 1,
    kind: "provider.started",
    data: { run_id: "run", step: 0, identity: { protocol: "openai-chat", model: "priced" } },
    ...(row.recorded ? { recorded_at_ms: 100 } : {}),
  })
  translator.dispatch({
    session_id: "ses_priced",
    seq: 2,
    kind: "usage",
    recorded_at_ms: 200,
    data: { run_id: row.run, step: row.step, model: row.usageModel, usage: { inputTokens: 100, outputTokens: 20 } },
  })
  translator.dispatch({
    session_id: "ses_priced",
    seq: 3,
    kind: "message.committed",
    recorded_at_ms: 300,
    data: { role: "assistant", content: [{ type: "text", text: "done" }] },
  })
  const ended = outputs.find((event) => event.type === "session.next.step.ended")?.data as {
    cost: number
    model?: { id: string }
  }
  expect(ended).toBeDefined()
  expect(ended.model?.id).toBe(row.expected)
  expect(ended.cost).toBeCloseTo(row.expected ? 0.14 : 0)
})

test("a native turn publishes each provider phase as the turn advances", () => {
  const { outputs, translator } = collect()
  translator.dispatch({
    session_id: "ses_phase",
    seq: 1,
    kind: "run.started",
    recorded_at_ms: 1000,
    data: {},
  })
  // The same phase recorded again is not a transition; a new step restarting
  // preparation after a tool result is.
  translator.dispatch({
    session_id: "ses_phase",
    seq: 2,
    kind: "provider.started",
    recorded_at_ms: 1100,
    data: {},
  })
  translator.dispatch({
    session_id: "ses_phase",
    seq: 3,
    kind: "provider.request",
    recorded_at_ms: 1200,
    data: {},
  })
  translator.progress({ session_id: "ses_phase", kind: "provider.ttft", ttft_ms: 900 })
  translator.dispatch({
    session_id: "ses_phase",
    seq: 4,
    kind: "provider.started",
    recorded_at_ms: 1300,
    data: {},
  })
  translator.dispatch({
    session_id: "ses_phase",
    seq: 5,
    kind: "run.finished",
    recorded_at_ms: 2000,
    data: {},
  })
  const phases = outputs
    .filter((event) => event.type === "session.next.status")
    .map((event) => (event.data as { status: unknown }).status)
  expect(phases).toEqual([
    { type: "busy", phase: "preparing", since: 1000 },
    { type: "busy", phase: "requesting", since: 1200 },
    { type: "busy", phase: "streaming", since: expect.any(Number) },
    { type: "busy", phase: "preparing", since: 1300 },
    { type: "idle" },
  ])
})
