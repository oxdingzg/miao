import { expect, test } from "bun:test"
import { StatusBridge, ToolBridge, productToolID, statusOf, translateApproval, translateApprovalResolved, translateMessage, translatePrompt, translateQuestion, translateStatus, translateTools } from "@/engine/bridge"
import type { EngineEvent } from "@/engine/client"

const event = (kind: string): EngineEvent => ({ session_id: "ses_test", seq: 1, kind, data: {} })

test("maps run lifecycle events to product status", () => {
  expect(statusOf(event("run.started"))).toEqual({ type: "busy" })
  expect(statusOf(event("run.finished"))).toEqual({ type: "idle" })
  expect(statusOf(event("provider.failed"))).toBeUndefined()
  expect(statusOf(event("message.committed"))).toBeUndefined()
})

test("translateStatus carries the engine session id and a status", () => {
  const status = translateStatus(event("run.started"))
  expect(`${status?.sessionID}`).toBe("ses_test")
  expect(status?.status).toEqual({ type: "busy" })
  expect(translateStatus(event("tool.planned"))).toBeUndefined()
})

test("StatusBridge emits only on a transition", () => {
  const bridge = new StatusBridge()
  expect(bridge.update(event("run.started"))?.status).toEqual({ type: "busy" })
  expect(bridge.update(event("message.committed"))).toBeUndefined()
  expect(bridge.update(event("run.started"))).toBeUndefined()
  expect(bridge.update(event("run.finished"))?.status).toEqual({ type: "idle" })
})

test("maps input.promoted to a prompt.admitted payload", () => {
  const event: EngineEvent = { session_id: "ses_abc", seq: 7, kind: "input.promoted", data: { input_id: "in_1", prompt: "hello" } }
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
      content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "c1", name: "read_file", input: {} }],
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
  expect(productToolID("apply_patch")).toBe("apply-patch")
  expect(productToolID("run_command")).toBe("bash")
  expect(productToolID("cron_list")).toBe("schedule")
  expect(productToolID("worker__echo")).toBe("custom")
})

test("correlates tool.completed with its committed call", () => {
  const bridge = new ToolBridge()
  bridge.note({
    session_id: "ses_abc",
    seq: 4,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
  })
  const success = bridge.result({ session_id: "ses_abc", seq: 6, kind: "tool.completed", data: { call_id: "c1", result: "contents", is_error: false } })
  expect(success?.type).toBe("session.next.tool.success")
  if (success?.type === "session.next.tool.success") {
    expect(String(success.assistantMessageID)).toBe("msg_ses_abc_4")
    expect(success.content[0]).toEqual({ type: "text", text: "contents" })
  }
  const failed = bridge.result({ session_id: "ses_abc", seq: 7, kind: "tool.completed", data: { call_id: "c1", result: "boom", is_error: true } })
  expect(failed?.type).toBe("session.next.tool.failed")
  if (failed?.type === "session.next.tool.failed") expect(failed.error.message).toBe("boom")
  expect(bridge.result({ session_id: "ses_abc", seq: 8, kind: "tool.completed", data: { call_id: "missing", result: "x" } })).toBeUndefined()
})

test("maps approval.requested to a permission.v2.asked payload", () => {
  const event: EngineEvent = {
    session_id: "ses_abc",
    seq: 2,
    kind: "approval.requested",
    data: { request_id: "req1", session_id: "ses_abc", tool: "write_file", resource: "file", input_hash: "h", policy_revision: "rev" },
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
      input: { questions: [{ question: "Pick", header: "pick", options: [{ label: "a", description: "A" }, { label: "b" }] }] },
    },
  }
  const asked = translateQuestion(event)
  expect(String(asked?.id)).toBe("que_q1")
  expect(String(asked?.sessionID)).toBe("ses_abc")
  expect(asked?.questions[0]?.question).toBe("Pick")
  expect(asked?.questions[0]?.options).toEqual([{ label: "a", description: "A" }, { label: "b", description: "" }])
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
    session_id: session, seq: 1, kind: "tool.planned",
    data: { call_id: `${run}/call`, provider_id: "call" },
  })
  const committed = (session: string, seq: number): EngineEvent => ({
    session_id: session, seq, kind: "message.committed",
    data: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
  })
  bridge.note(planned("ses_a", "run1"))
  bridge.note(committed("ses_a", 2))
  bridge.note(planned("ses_a", "run2"))
  bridge.note(committed("ses_a", 5))
  bridge.note(planned("ses_b", "run1"))
  bridge.note(committed("ses_b", 9))
  const result = (session: string, run: string) => bridge.result({
    session_id: session, seq: 10, kind: "tool.completed",
    data: { call_id: `${run}/call`, result: "contents", is_error: false },
  })
  expect(String(result("ses_a", "run1")?.assistantMessageID)).toBe("msg_ses_a_2")
  expect(String(result("ses_a", "run2")?.assistantMessageID)).toBe("msg_ses_a_5")
  expect(String(result("ses_b", "run1")?.assistantMessageID)).toBe("msg_ses_b_9")
  expect(result("ses_a", "run1")?.callID).toBe("call")
  expect(result("ses_missing", "run1")).toBeUndefined()
})
