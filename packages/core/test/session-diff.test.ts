import { describe, expect, test } from "bun:test"
import { SessionDiff } from "@miao/core/session/diff"

describe("SessionDiff.baselineSnapshot", () => {
  test("returns the earliest recorded step snapshot", () => {
    const baseline = SessionDiff.baselineSnapshot([
      { type: "session.next.created", data: { sessionID: "ses_x" } },
      { type: "session.next.step.started", data: { assistantMessageID: "m1" } },
      { type: "session.next.step.started", data: { assistantMessageID: "m2", snapshot: "tree-a" } },
      { type: "session.next.step.started", data: { assistantMessageID: "m3", snapshot: "tree-b" } },
    ])
    expect(baseline).toBe("tree-a")
  })

  test("returns undefined when no snapshot was recorded", () => {
    expect(SessionDiff.baselineSnapshot([{ type: "session.next.synthetic", data: { text: "hi" } }])).toBeUndefined()
    expect(SessionDiff.baselineSnapshot([])).toBeUndefined()
  })
})
