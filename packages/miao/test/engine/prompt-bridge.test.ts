import { expect, test } from "bun:test"
import { PromptBridge } from "@/engine/bridge"
import type { EngineEvent } from "@/engine/client"

function event(session: string, kind: string, data: unknown): EngineEvent {
  return { session_id: session, seq: 1, kind, data }
}

test("prompt delivery requires matching admission facts and never borrows another Session's mode", () => {
  const bridge = new PromptBridge()
  expect(bridge.project(event("ses_a", "input.admitted", { input_id: "input", delivery: "queue" }))).toBeUndefined()
  expect(bridge.project(event("ses_b", "input.promoted", { input_id: "input", prompt: "other" }))).toBeUndefined()
  expect(bridge.project(event("ses_a", "input.promoted", { input_id: "input", prompt: "queued" }))?.delivery).toBe(
    "queue",
  )
  expect(bridge.project(event("ses_a", "input.promoted", { input_id: "input", prompt: "queued" }))).toBeUndefined()
})

test("missing or unknown delivery does not manufacture a steering prompt", () => {
  const bridge = new PromptBridge()
  bridge.project(event("ses_a", "input.admitted", { input_id: "input" }))
  expect(bridge.project(event("ses_a", "input.promoted", { input_id: "input", prompt: "unknown" }))).toBeUndefined()
  bridge.project(event("ses_a", "input.admitted", { input_id: "input", delivery: "unexpected" }))
  expect(bridge.project(event("ses_a", "input.promoted", { input_id: "input", prompt: "unknown" }))).toBeUndefined()
  bridge.project(event("ses_a", "input.admitted", { input_id: "input", delivery: "steer" }))
  expect(bridge.project(event("ses_a", "input.promoted", { input_id: "input", prompt: null }))).toBeUndefined()
  expect(bridge.project(event("ses_a", "input.promoted", { input_id: "input", prompt: "valid" }))?.delivery).toBe(
    "steer",
  )
})
