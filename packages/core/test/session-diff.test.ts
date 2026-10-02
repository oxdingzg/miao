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

describe("SessionDiff.turnSnapshots", () => {
  const events = [
    { type: "session.next.prompted", data: { messageID: "msg_1" } },
    { type: "session.next.step.started", data: { snapshot: "tree-1a" } },
    { type: "session.next.step.ended", data: { snapshot: "tree-1b" } },
    { type: "session.next.step.started", data: { snapshot: "tree-1b" } },
    { type: "session.next.step.ended", data: { snapshot: "tree-1c" } },
    { type: "session.next.prompted", data: { messageID: "msg_2" } },
    { type: "session.next.step.started", data: { snapshot: "tree-2a" } },
    { type: "session.next.step.ended", data: { snapshot: "tree-2b" } },
    { type: "session.next.prompted", data: { messageID: "msg_3" } },
    { type: "session.next.step.started", data: { snapshot: "tree-3a" } },
  ]

  test("spans a finished turn from its first step start to its last step end", () => {
    expect(SessionDiff.turnSnapshots(events, "msg_1")).toEqual({ from: "tree-1a", to: "tree-1c" })
    expect(SessionDiff.turnSnapshots(events, "msg_2")).toEqual({ from: "tree-2a", to: "tree-2b" })
  })

  test("leaves the end open while the turn has not finished a step", () => {
    expect(SessionDiff.turnSnapshots(events, "msg_3")).toEqual({ from: "tree-3a", to: undefined })
  })

  test("returns undefined for an unknown message or a turn without snapshots", () => {
    expect(SessionDiff.turnSnapshots(events, "msg_missing")).toBeUndefined()
    expect(
      SessionDiff.turnSnapshots(
        [
          { type: "session.next.prompted", data: { messageID: "msg_1" } },
          { type: "session.next.step.started", data: {} },
        ],
        "msg_1",
      ),
    ).toBeUndefined()
  })
})
