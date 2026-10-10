import { expect, test } from "bun:test"
import { StatusBridge, statusOf, translateMessage, translatePrompt, translateStatus, translateTools } from "@/engine/bridge"
import type { EngineEvent } from "@/engine/client"

const event = (kind: string): EngineEvent => ({ session_id: "ses_test", seq: 1, kind, data: {} })

test("maps run lifecycle events to product status", () => {
  expect(statusOf(event("run.started"))).toEqual({ type: "busy" })
  expect(statusOf(event("run.finished"))).toEqual({ type: "idle" })
  expect(statusOf(event("provider.failed"))).toEqual({ type: "idle" })
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
  expect(calls[0]?.tool).toBe("read_file")
  expect(calls[0]?.input).toEqual({ path: "file" })
  expect(calls[0]?.provider).toEqual({ executed: false })
  expect(String(calls[0]?.assistantMessageID)).toBe("msg_ses_abc_4")
  expect(translateTools({ ...event, kind: "run.finished" })).toEqual([])
})
