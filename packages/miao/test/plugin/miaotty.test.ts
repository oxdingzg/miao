import { expect, test } from "bun:test"
import type { Event } from "@miao/sdk/v2"
import { createMiaottyStateTracker, terminalTarget } from "@/plugin/miaotty"

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

test("reports through mtty's variables and still understands an older miaotty", () => {
  expect(terminalTarget({})).toBeUndefined()
  expect(terminalTarget({ MTTY_PANE_ID: "pane1", MTTY_CLI: "/Apps/mtty.app/mtty-cli" })).toEqual({
    pane: "pane1",
    exe: "/Apps/mtty.app/mtty-cli",
  })
  expect(terminalTarget({ MTTY_PANE_ID: "pane1" })).toEqual({ pane: "pane1", exe: "mtty-cli" })
  expect(terminalTarget({ MIAOTTY_PANE_ID: "pane2" })).toEqual({ pane: "pane2", exe: "miaotty-cli" })
  expect(terminalTarget({ MTTY_PANE_ID: "new", MIAOTTY_PANE_ID: "old", MIAOTTY_CLI: "/x/cli" })).toEqual({
    pane: "new",
    exe: "/x/cli",
  })
})
