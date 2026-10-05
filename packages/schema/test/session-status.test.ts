import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event"
import { SessionStatusEvent } from "../src/session-status-event"

const decode = Schema.decodeUnknownSync(SessionEvent.StatusInfo)

describe("session status", () => {
  test("shares one canonical definition with the compat event", () => {
    expect(SessionStatusEvent.Info).toBe(SessionEvent.StatusInfo)
  })

  test("decodes idle and phased busy statuses", () => {
    expect(decode({ type: "idle" })).toEqual({ type: "idle" })
    expect(decode({ type: "busy", phase: "requesting", since: 1 })).toEqual({
      type: "busy",
      phase: "requesting",
      since: 1,
    })
  })

  test("allows an omitted phase for optimistic writes", () => {
    expect(decode({ type: "busy" })).toEqual({ type: "busy" })
  })

  test("keeps retry detail", () => {
    expect(decode({ type: "retry", attempt: 2, message: "rate limited", next: 5 })).toEqual({
      type: "retry",
      attempt: 2,
      message: "rate limited",
      next: 5,
    })
  })
})
