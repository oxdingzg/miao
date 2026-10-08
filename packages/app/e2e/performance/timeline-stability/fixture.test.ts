import { describe, expect, test } from "bun:test"
import {
  assistantID,
  assistantMessage,
  event,
  status,
  toolPart,
  userMessage,
  validateTimelineEvent,
  validateTimelineMessages,
  type PartSeed,
} from "./fixture"

describe("timeline fixture validation", () => {
  test("accepts a valid timeline", () => {
    expect(validateTimelineMessages([userMessage(), assistantMessage()])).toHaveLength(2)
  })

  test("rejects malformed SDK values at runtime", () => {
    expect(() =>
      assistantMessage([], {
        error: { name: "APIError", data: { message: "failed" } } as never,
      }),
    ).toThrow()
    expect(() =>
      validateTimelineEvent({
        id: "evt_timeline_0001",
        type: "session.next.status",
        location: { directory: "C:/OpenCode/TimelineStability" },
        data: { sessionID: "ses_timeline_stability", timestamp: 1700000003000, status: { type: "retry", attempt: 1 } },
      }),
    ).toThrow()
  })

  test("rejects duplicate IDs and orphan assistants", () => {
    expect(() => validateTimelineMessages([userMessage(), userMessage()])).toThrow(/duplicate message ID/)
    expect(() =>
      validateTimelineMessages([userMessage(), assistantMessage([], { parentID: "msg_missing_parent" })]),
    ).toThrow(/parent user/)
  })

  test("assigns deterministic event IDs", () => {
    const first = status("busy")
    const second = status("idle")
    expect(first.id).toMatch(/^evt_timeline_\d{4}$/)
    expect(Number(second.id.slice(-4))).toBe(Number(first.id.slice(-4)) + 1)
    const removal = event("message.part.removed", {
      sessionID: "ses_timeline_stability",
      messageID: assistantID,
      partID: "prt_x",
    })
    expect(removal.payload.id).toMatch(/^evt_timeline_\d{4}$/)
  })
})

if (false) {
  const userSeed = { id: "prt_type_user", type: "text", text: "typed" } satisfies PartSeed<"user">
  userMessage([userSeed])

  // @ts-expect-error Tool completion fields are not valid while pending.
  toolPart("prt_invalid_pending", "bash", "pending", {}, { output: "impossible" })
  // @ts-expect-error Tool completion fields are not valid while running.
  toolPart("prt_invalid_running", "bash", "running", {}, { output: "impossible" })
  // @ts-expect-error Tool error fields are not valid after completion.
  toolPart("prt_invalid_completed", "bash", "completed", {}, { error: "impossible" })

  assistantMessage([
    // @ts-expect-error Agent references belong to user messages, not assistant messages.
    { id: "prt_invalid_owner", type: "agent", name: "explore", source: { value: "@explore", start: 0, end: 8 } },
  ])
}
