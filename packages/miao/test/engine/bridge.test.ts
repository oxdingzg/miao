import { expect, test } from "bun:test"
import { StatusBridge, statusOf, translatePrompt, translateStatus } from "@/engine/bridge"
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
