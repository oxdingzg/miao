import { expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { createMiaottyStateTracker } from "@/plugin/miaotty"

const event = (value: object) => value as unknown as Event

test("maps session activity to processing and idle", () => {
  const tracker = createMiaottyStateTracker()
  expect(tracker.current).toBe("idle")
  expect(tracker.handle(event({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } }))).toBe(
    "processing",
  )
  expect(
    tracker.handle(event({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } })),
  ).toBeUndefined()
  expect(
    tracker.handle(event({ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } })),
  ).toBe("idle")
})

test("pending questions or permissions surface as awaiting", () => {
  const tracker = createMiaottyStateTracker()
  tracker.handle(event({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } }))
  expect(tracker.handle(event({ type: "question.asked", properties: { id: "q1", sessionID: "s1" } }))).toBe("awaiting")
  expect(tracker.handle(event({ type: "permission.asked", properties: { id: "p1", sessionID: "s1" } }))).toBeUndefined()
  expect(tracker.handle(event({ type: "question.replied", properties: { requestID: "q1", sessionID: "s1" } }))).toBe(
    undefined,
  )
  expect(tracker.handle(event({ type: "permission.replied", properties: { requestID: "p1", sessionID: "s1" } }))).toBe(
    "processing",
  )
})

test("errors show until the session becomes active again", () => {
  const tracker = createMiaottyStateTracker()
  expect(tracker.handle(event({ type: "session.error", properties: { sessionID: "s1" } }))).toBe("error")
  expect(
    tracker.handle(event({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } })),
  ).toBe("processing")
})
