import { expect, test } from "bun:test"
import {
  StatusBridge,
  ToolBridge,
  productToolID,
  productToolInput,
  productToolResult,
  progressStatus,
  statusOf,
  translateApproval,
  translateApprovalResolved,
  translateMessage,
  translatePrompt,
  translateQuestion,
  translateQuestionResolved,
  translateStatus,
  translateStepEnded,
  translateTools,
  translateUsage,
} from "@/engine/bridge"
import { messageID } from "@/engine/identity"
import { translateExpiredCredential } from "@/engine/bridge"
import type { EngineEvent } from "@/engine/client"
import type { ModelV2 } from "@miao/core/model"
import { Model } from "@miao/schema/model"
import { Provider } from "@miao/schema/provider"

const event = (kind: string, recordedAtMs?: number): EngineEvent => ({
  session_id: "ses_test",
  seq: 1,
  kind,
  data: {},
  ...(recordedAtMs === undefined ? {} : { recorded_at_ms: recordedAtMs }),
})

test("maps run lifecycle events to product status", () => {
  expect(statusOf(event("run.started"))).toEqual({ type: "busy", phase: "preparing" })
  expect(statusOf(event("run.started", 1_700_000_000_000))).toEqual({
    type: "busy",
    phase: "preparing",
    since: 1_700_000_000_000,
  })
  expect(statusOf(event("run.finished"))).toEqual({ type: "idle" })
  expect(statusOf(event("provider.failed"))).toBeUndefined()
  expect(statusOf(event("message.committed"))).toBeUndefined()
})

test("names the phase of a provider step from the durable events", () => {
  // Local preparation is distinguishable from an unanswered request: the
  // latter is what an operator reads as a stalled turn.
  expect(statusOf(event("provider.started", 1_700_000_000_100))).toEqual({
    type: "busy",
    phase: "preparing",
    since: 1_700_000_000_100,
  })
  expect(statusOf(event("provider.request", 1_700_000_000_200))).toEqual({
    type: "busy",
    phase: "requesting",
    since: 1_700_000_000_200,
  })
  expect(statusOf(event("provider.retry", 1_700_000_000_300))).toEqual({
    type: "busy",
    phase: "retrying",
    since: 1_700_000_000_300,
  })
})

test("the first token turns a dispatched request into a stream", () => {
  expect(progressStatus({ session_id: "ses_test", kind: "provider.ttft", ttft_ms: 58_000 })).toEqual({
    type: "busy",
    phase: "streaming",
    since: expect.any(Number),
  })
  expect(progressStatus({ session_id: "ses_test", kind: "provider.delta" })).toBeUndefined()
})

test("translateStatus carries the engine session id and a status", () => {
  const status = translateStatus(event("run.started"))
  expect(`${status?.sessionID}`).toBe("ses_test")
  expect(status?.status).toEqual({ type: "busy", phase: "preparing" })
  expect(translateStatus(event("tool.planned"))).toBeUndefined()
})

test("StatusBridge emits only on a transition", () => {
  const bridge = new StatusBridge()
  expect(bridge.update(event("run.started"))?.status).toEqual({ type: "busy", phase: "preparing" })
  expect(bridge.update(event("message.committed"))).toBeUndefined()
  expect(bridge.update(event("run.started"))).toBeUndefined()
  // A phase change inside busy is a real transition, not a heartbeat.
  expect(bridge.update(event("provider.request", 1_700_000_000_200))?.status).toEqual({
    type: "busy",
    phase: "requesting",
    since: 1_700_000_000_200,
  })
  expect(bridge.update(event("provider.request", 1_700_000_000_201))).toBeUndefined()
  expect(bridge.progress({ session_id: "ses_test", kind: "provider.ttft", ttft_ms: 1200 })?.status).toEqual({
    type: "busy",
    phase: "streaming",
    since: expect.any(Number),
  })
  expect(bridge.progress({ session_id: "ses_test", kind: "provider.ttft", ttft_ms: 1300 })).toBeUndefined()
  expect(bridge.update(event("run.finished"))?.status).toEqual({ type: "idle" })
})

test("maps input.promoted to a prompt.admitted payload", () => {
  const event: EngineEvent = {
    session_id: "ses_abc",
    seq: 7,
    kind: "input.promoted",
    data: { input_id: "in_1", prompt: "hello" },
  }
  const admitted = translatePrompt(event)
  expect(String(admitted?.messageID)).toBe("msg_ses_abc_7")
  expect(admitted?.prompt).toEqual({ text: "hello" })
  expect(String(admitted?.sessionID)).toBe("ses_abc")
  expect(admitted?.delivery).toBe("steer")
  expect(translatePrompt({ ...event, kind: "run.started" })).toBeUndefined()
})

test("maps a committed assistant message to text.ended events", () => {
  const event: EngineEvent = {
    session_id: "ses_abc",
    seq: 9,
    kind: "message.committed",
    data: {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "c1", name: "read_file", input: {} },
      ],
    },
  }
  const events = translateMessage(event)
  expect(events).toHaveLength(1)
  expect(String(events[0]?.assistantMessageID)).toBe("msg_ses_abc_9")
  expect(events[0]?.textID).toBe("text_9_0")
  expect(events[0]?.text).toBe("hello")
  expect(String(events[0]?.sessionID)).toBe("ses_abc")
  expect(translateMessage({ ...event, data: { role: "user", content: [{ type: "text", text: "hi" }] } })).toEqual([])
  expect(translateMessage({ ...event, kind: "run.started" })).toEqual([])
})

test("anchored text ordinals exclude reasoning and tool blocks while legacy IDs retain their indices", () => {
  const content = [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "first" },
    { type: "tool_use", id: "call", name: "read_file", input: {} },
    { type: "text", text: "second" },
  ]
  const base: EngineEvent = { session_id: "ses_abc", seq: 9, kind: "message.committed", data: {} }
  const anchored = translateMessage({ ...base, data: { role: "assistant", anchor_seq: 4, content } })
  expect(anchored.map((part) => part.textID)).toEqual(["text_4_0", "text_4_1"])
  expect(anchored.map((part) => part.text)).toEqual(["first", "second"])
  const legacy = translateMessage({ ...base, data: { role: "assistant", content } })
  expect(legacy.map((part) => part.textID)).toEqual(["text_9_1", "text_9_3"])
})

test("maps a committed assistant tool_use block to tool.called", () => {
  const event: EngineEvent = {
    session_id: "ses_abc",
    seq: 4,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "file" } }] },
  }
  const calls = translateTools(event)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.callID).toBe("c1")
  expect(calls[0]?.tool).toBe("read")
  expect(calls[0]?.input).toEqual({ path: "file" })
  expect(calls[0]?.provider).toEqual({ executed: false })
  expect(String(calls[0]?.assistantMessageID)).toBe("msg_ses_abc_4")
  expect(translateTools({ ...event, kind: "run.finished" })).toEqual([])
})

test("maps engine tool names to product tool ids", () => {
  expect(productToolID("read_file")).toBe("read")
  expect(productToolID("list_files")).toBe("read")
  expect(productToolID("apply_patch")).toBe("apply_patch")
  expect(productToolID("run_command")).toBe("bash")
  expect(productToolID("start_job")).toBe("bash")
  expect(productToolID("job_status")).toBe("job_list")
  expect(productToolID("job_list")).toBe("job_list")
  expect(productToolID("job_wait")).toBe("job_wait")
  expect(productToolID("cancel_job")).toBe("job_cancel")
  expect(productToolID("monitor")).toBe("monitor")
  expect(productToolID("task_list")).toBe("task_list")
  expect(productToolID("cron_list")).toBe("schedule")
  expect(productToolID("mcp_dice_roll_dice")).toBe("mcp__dice__roll_dice")
  expect(productToolID("mcp_dice_roll_dice_f03cf0c725b907c9894d9e5988840834")).toBe("mcp__dice__roll_dice")
  expect(productToolID("worker__echo")).toBe("worker__echo")
  expect(productToolID("session_state")).toBe("session_state")
  expect(productToolID("session_message")).toBe("session_message")
})

test("projects engine shell results into the product bash shape", () => {
  expect(
    productToolResult("bash", {
      stdout: "line one\n",
      stderr: "",
      exit_code: 0,
      signal: null,
      reason: "completed",
      output_incomplete: false,
      sandbox_profile: "workspace_write",
      enforcement_required: true,
      network_allowed: true,
    }),
  ).toEqual({
    structured: {
      exit: 0,
      truncated: false,
      sandbox: { state: "sandboxed", backend: "workspace_write", network: true, denied: [], approved: [] },
    },
    text: "line one\n[exit code 0]",
  })
  expect(productToolResult("bash", "plain output")).toEqual({ structured: {}, text: "plain output" })
})

test("the engine's timed_out reason projects the timeout marker", () => {
  const result = productToolResult("bash", {
    stdout: "",
    stderr: "",
    exit_code: null,
    signal: null,
    reason: "timed_out",
    output_incomplete: true,
    sandbox_profile: "workspace_write",
    enforcement_required: true,
    network_allowed: true,
  })
  expect(result.structured).toMatchObject({ timeout: true, truncated: true })
  expect(result.text).toContain("[command timed out]")
})

test("unwraps engine session-state mutations to the tool contract", () => {
  const todos = [{ id: "t1", content: "first", status: "pending", priority: "high" }]
  expect(productToolResult("todowrite", { kind: "todos", revision: 7, value: { todos }, duplicate: false })).toEqual({
    structured: { todos },
    text: JSON.stringify(todos, null, 2),
  })
  const goal = { objective: "ship", status: "active" }
  expect(productToolResult("goal", { kind: "goal", revision: 3, value: goal, duplicate: false })).toEqual({
    structured: goal,
    text: JSON.stringify(goal, null, 2),
  })
})

test("projects start_job input into the product bash shape", () => {
  expect(productToolInput("start_job", { argv: ["bash", "-c", "sleep 2"], timeout_ms: 1000 })).toEqual({
    command: "sleep 2",
    run_in_background: true,
  })
  expect(productToolInput("start_job", { argv: ["echo", "hi"] })).toEqual({ command: "echo hi", run_in_background: true })
  expect(productToolInput("bash", { command: "ls" })).toEqual({ command: "ls" })
})

test("projects engine task input into the product task shape", () => {
  expect(
    productToolInput("task", {
      prompt: "Explore the repo\n\nSymptom: tab title",
      agent: "explore",
      background: true,
    }),
  ).toEqual({
    prompt: "Explore the repo\n\nSymptom: tab title",
    agent: "explore",
    subagent_type: "explore",
    description: "Explore the repo",
    background: true,
  })
  expect(productToolInput("read_file", { path: "a" })).toEqual({ path: "a" })
})

test("tool.completed for a shell call carries the projected result", () => {
  const bridge = new ToolBridge()
  bridge.note({
    session_id: "ses_abc",
    seq: 4,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "run_command", input: {} }] },
  })
  const success = bridge.result({
    session_id: "ses_abc",
    seq: 6,
    kind: "tool.completed",
    data: {
      call_id: "c1",
      result: { stdout: "ok\n", stderr: "", exit_code: 0, reason: "completed", output_incomplete: false },
      is_error: false,
    },
  })
  expect(success?.type).toBe("session.next.tool.success")
  if (success?.type === "session.next.tool.success") {
    expect(success.content[0]).toEqual({ type: "text", text: "ok\n[exit code 0]" })
    expect(success.structured).toMatchObject({ exit: 0 })
  }
})

test("correlates tool.completed with its committed call", () => {
  const bridge = new ToolBridge()
  bridge.note({
    session_id: "ses_abc",
    seq: 4,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
  })
  const success = bridge.result({
    session_id: "ses_abc",
    seq: 6,
    kind: "tool.completed",
    data: { call_id: "c1", result: "contents", is_error: false },
  })
  expect(success?.type).toBe("session.next.tool.success")
  if (success?.type === "session.next.tool.success") {
    expect(String(success.assistantMessageID)).toBe("msg_ses_abc_4")
    expect(success.content[0]).toEqual({ type: "text", text: "contents" })
  }
  const failed = bridge.result({
    session_id: "ses_abc",
    seq: 7,
    kind: "tool.completed",
    data: { call_id: "c1", result: "boom", is_error: true },
  })
  expect(failed?.type).toBe("session.next.tool.failed")
  if (failed?.type === "session.next.tool.failed") expect(failed.error.message).toBe("boom")
  expect(
    bridge.result({ session_id: "ses_abc", seq: 8, kind: "tool.completed", data: { call_id: "missing", result: "x" } }),
  ).toBeUndefined()
})

test("maps approval.requested to a permission.v2.asked payload", () => {
  const event: EngineEvent = {
    session_id: "ses_abc",
    seq: 2,
    kind: "approval.requested",
    data: {
      request_id: "req1",
      session_id: "ses_abc",
      tool: "write_file",
      resource: "file",
      input_hash: "h",
      policy_revision: "rev",
    },
  }
  const asked = translateApproval(event)
  expect(String(asked?.id)).toBe("per_req1")
  expect(String(asked?.sessionID)).toBe("ses_abc")
  expect(asked?.action).toBe("write")
  expect(asked?.resources).toEqual(["file"])
  expect(asked?.metadata).toEqual({ request_id: "req1", input_hash: "h", policy_revision: "rev" })
  expect(translateApproval({ ...event, kind: "run.started" })).toBeUndefined()
})

test("maps approval.resolved to a permission.v2.replied payload", () => {
  const base = { session_id: "ses_abc", seq: 3, kind: "approval.resolved" } as const
  const allow = translateApprovalResolved({ ...base, data: { request_id: "req1", state: "allow" } })
  expect(String(allow?.requestID)).toBe("per_req1")
  expect(String(allow?.sessionID)).toBe("ses_abc")
  expect(allow?.reply).toBe("once")
  expect(translateApprovalResolved({ ...base, data: { request_id: "req1", state: "deny" } })?.reply).toBe("reject")
  expect(translateApprovalResolved({ ...base, data: { request_id: "req1", state: "expired" } })?.reply).toBe("reject")
  expect(translateApprovalResolved({ ...base, kind: "run.started", data: {} })).toBeUndefined()
})

test("maps question.requested to a question.v2.asked payload", () => {
  const event: EngineEvent = {
    session_id: "ses_abc",
    seq: 5,
    kind: "question.requested",
    data: {
      question_id: "q1",
      input: {
        questions: [{ question: "Pick", header: "pick", options: [{ label: "a", description: "A" }, { label: "b" }] }],
      },
    },
  }
  const asked = translateQuestion(event)
  expect(String(asked?.id)).toBe("que_q1")
  expect(String(asked?.sessionID)).toBe("ses_abc")
  expect(asked?.questions[0]?.question).toBe("Pick")
  expect(asked?.questions[0]?.options).toEqual([
    { label: "a", description: "A" },
    { label: "b", description: "" },
  ])
  expect(asked?.questions[0]?.custom).toBe(true)
  expect(translateQuestion({ ...event, kind: "run.started", data: {} })).toBeUndefined()
})

test("status transitions are isolated by Session and only terminal events idle a run", () => {
  const bridge = new StatusBridge()
  expect(bridge.update({ ...event("run.started"), session_id: "ses_a" })?.status.type).toBe("busy")
  expect(bridge.update({ ...event("run.started"), session_id: "ses_b" })?.status.type).toBe("busy")
  expect(bridge.update({ ...event("provider.failed"), session_id: "ses_a" })).toBeUndefined()
  expect(bridge.update({ ...event("run.finished"), session_id: "ses_a" })?.status.type).toBe("idle")
  expect(bridge.update({ ...event("run.started"), session_id: "ses_b" })).toBeUndefined()
})

test("run-scoped tool keys retain the originating message across reused provider ids", () => {
  const bridge = new ToolBridge()
  const planned = (session: string, run: string): EngineEvent => ({
    session_id: session,
    seq: 1,
    kind: "tool.planned",
    data: { call_id: `${run}/call`, provider_id: "call" },
  })
  const committed = (session: string, seq: number): EngineEvent => ({
    session_id: session,
    seq,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
  })
  bridge.note(planned("ses_a", "run1"))
  bridge.note(committed("ses_a", 2))
  bridge.note(planned("ses_a", "run2"))
  bridge.note(committed("ses_a", 5))
  bridge.note(planned("ses_b", "run1"))
  bridge.note(committed("ses_b", 9))
  const result = (session: string, run: string) =>
    bridge.result({
      session_id: session,
      seq: 10,
      kind: "tool.completed",
      data: { call_id: `${run}/call`, result: "contents", is_error: false },
    })
  expect(String(result("ses_a", "run1")?.assistantMessageID)).toBe("msg_ses_a_2")
  expect(String(result("ses_a", "run2")?.assistantMessageID)).toBe("msg_ses_a_5")
  expect(String(result("ses_b", "run1")?.assistantMessageID)).toBe("msg_ses_b_9")
  expect(result("ses_a", "run1")?.callID).toBe("call")
  expect(result("ses_missing", "run1")).toBeUndefined()
})

test("maps question.resolved to the product reply with matching request id", () => {
  const resolved = translateQuestionResolved({
    session_id: "ses_abc",
    seq: 6,
    kind: "question.resolved",
    data: { question_id: "q1", state: "answered", answers: [["a"], []] },
  })
  expect(resolved).toEqual({
    type: "question.v2.replied",
    data: {
      sessionID: expect.anything(),
      requestID: expect.anything(),
      answers: [["a"], []],
    },
  })
})

test("an expired or cancelled question is rejected and malformed resolutions are dropped", () => {
  const base = { session_id: "ses_abc", seq: 6, kind: "question.resolved" } as const
  expect(translateQuestionResolved({ ...base, data: { question_id: "q1", state: "expired" } })?.type).toBe(
    "question.v2.rejected",
  )
  expect(
    translateQuestionResolved({ ...base, data: { question_id: "q1", state: "cancelled", recovered: true } })?.type,
  ).toBe("question.v2.rejected")
  expect(translateQuestionResolved({ ...base, data: { state: "answered", answers: [] } })).toBeUndefined()
  expect(translateQuestionResolved({ ...base, data: { question_id: "q1", state: "answered" } })).toBeUndefined()
  expect(
    translateQuestionResolved({ ...base, data: { question_id: "q1", state: "answered", answers: ["a"] } }),
  ).toBeUndefined()
  expect(translateQuestionResolved({ ...base, data: { question_id: "q1", state: "pending" } })).toBeUndefined()
})

test("buffers billed usage from the journal and drops partials", () => {
  const usageData: object = {
    run_id: "r1",
    step: 0,
    usage: { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 12 },
  }
  const usageEvent: EngineEvent = {
    session_id: "ses_test",
    seq: 3,
    kind: "usage",
    recorded_at_ms: 10,
    data: usageData,
  }
  const billed = translateUsage(usageEvent)
  expect(billed?.runID).toBe("r1")
  expect(billed?.usage.tokens).toEqual({ input: 30, output: 5, reasoning: 0, cache: { read: 12, write: 0 } })
  const partial: EngineEvent = { ...usageEvent, data: { ...usageData, partial: true } }
  expect(translateUsage(partial)).toBeUndefined()
})

test("settles a step on the committed assistant message", () => {
  const commit: EngineEvent = {
    session_id: "ses_test",
    seq: 7,
    kind: "message.committed",
    recorded_at_ms: 20,
    data: { role: "assistant", finish: "tool-calls", content: [] },
  }
  const ended = translateStepEnded(
    commit,
    { tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 12, write: 0 } } },
    95,
    undefined,
    undefined,
  )
  expect(`${ended?.sessionID}`).toBe("ses_test")
  expect(ended?.assistantMessageID).toBe(messageID("ses_test", 7))
  expect(ended?.finish).toBe("tool-calls")
  expect(ended?.tokens).toEqual({ input: 30, output: 5, reasoning: 0, cache: { read: 12, write: 0 } })
  expect(ended?.ttft).toBe(95)
  expect(ended?.cost).toBe(0)

  // Catalog rates price the step: billed input excludes what the cache served,
  // and reasoning tokens ride the output rate.
  const rates = [{ input: 1, output: 3, cache: { read: 0.1, write: 0.2 } }] as ModelV2.Info["cost"]
  const priced = translateStepEnded(
    commit,
    { tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 12, write: 0 } } },
    95,
    rates,
    { providerID: Provider.ID.make("p"), id: Model.ID.make("m") },
  )
  expect(priced?.cost).toBeCloseTo((18 * 1 + 5 * 3 + 12 * 0.1) / 1_000_000, 12)

  // No buffered usage settles with zeroed tokens and no ttft claim.
  const bare = translateStepEnded(commit, undefined, undefined, undefined, undefined)
  expect(bare?.tokens.input).toBe(0)
  expect(bare?.ttft).toBeUndefined()
  expect(bare?.cost).toBe(0)

  // A user commit never settles a step.
  const userData: object = { role: "user", content: [] }
  const user: EngineEvent = { ...commit, data: userData }
  expect(translateStepEnded(user, undefined, undefined, undefined, undefined)).toBeUndefined()
})

test("translateExpiredCredential parses the structured expired failure", () => {
  const make = (message: string | undefined): EngineEvent => ({
    kind: "stop_failure",
    seq: 1,
    session_id: "ses_test",
    recorded_at_ms: 1,
    ...(message === undefined ? {} : { data: { reason: "error", message } } as object),
  }) as unknown as EngineEvent

  const identity = translateExpiredCredential(
    make("credential cred_1 (openai) is expired; its owning broker must refresh it"),
  )
  expect(identity).toEqual({ id: "cred_1", integration: "openai" })

  expect(translateExpiredCredential(make("invalid request: credential: credential cred_google (google) is expired; its owning broker must refresh it"))).toEqual({ id: "cred_google", integration: "google" })
  expect(translateExpiredCredential(make("credential: credential cred_google (google) is expired; its owning broker must refresh it"))).toEqual({ id: "cred_google", integration: "google" })
  // An unrelated failure carries no credential identity.
  expect(translateExpiredCredential(make("provider connection refused"))).toBeUndefined()
  expect(translateExpiredCredential(make(undefined))).toBeUndefined()
})

test("native commits infer tool continuation without overriding explicit finishes", () => {
  const commit: EngineEvent = {
    session_id: "ses_test",
    seq: 7,
    kind: "message.committed",
    recorded_at_ms: 20,
    data: {
      role: "assistant",
      content: [
        { type: "text", text: "Checking" },
        { type: "tool_use", id: "call", name: "run_command", input: {} },
      ],
    },
  }
  expect(translateStepEnded(commit, undefined, undefined, undefined, undefined)?.finish).toBe("tool-calls")
  expect(
    translateStepEnded(
      { ...commit, data: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
      undefined,
      undefined,
      undefined,
      undefined,
    )?.finish,
  ).toBe("stop")
  expect(
    translateStepEnded(
      { ...commit, data: { role: "assistant", content: [{ type: "tool_use" }], finish: "length" } },
      undefined,
      undefined,
      undefined,
      undefined,
    )?.finish,
  ).toBe("length")
})
