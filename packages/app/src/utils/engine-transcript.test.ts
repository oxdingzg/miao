import { describe, expect, test } from "bun:test"
import type { EngineEvent } from "@miao/client/engine"
import { appendEvents, summarizeEvent, type TranscriptRow } from "./engine-transcript"

const event = (seq: number, kind: string, data: unknown = {}): EngineEvent => ({
  session_id: "ses_b",
  seq,
  kind,
  data,
})

describe("appendEvents", () => {
  test("appends committed events in seq order", () => {
    const rows = appendEvents([], [event(1, "session.initialized", { title: "Events probe" }), event(2, "message.committed")])
    expect(rows).toEqual([
      { seq: 1, kind: "session.initialized", summary: "Events probe" },
      { seq: 2, kind: "message.committed", summary: "" },
    ])
  })

  test("drops a replayed or out-of-order event instead of rendering it twice", () => {
    const start: TranscriptRow[] = [{ seq: 5, kind: "message.committed", summary: "" }]
    expect(appendEvents(start, [event(5, "message.committed"), event(4, "message.committed")])).toEqual(start)
    expect(appendEvents(start, [event(6, "message.committed")]).map((row) => row.seq)).toEqual([5, 6])
  })

  test("keeps the incoming batch ordered even when a page is already sorted", () => {
    const rows = appendEvents([], [event(1, "a"), event(2, "b"), event(3, "c")])
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3])
  })
})

describe("summarizeEvent", () => {
  test("prefers human fields over a raw payload", () => {
    expect(summarizeEvent(event(1, "x", { path: "/tmp/a.ts", tool: "read" }))).toBe("/tmp/a.ts")
    expect(summarizeEvent(event(1, "x", "plain text"))).toBe("plain text")
  })

  test("clips long or multi-line values to one bounded line", () => {
    const summary = summarizeEvent(event(1, "x", { text: `a\n${"b".repeat(200)}` }))
    expect(summary.startsWith("a ")).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(120)
  })

  test("returns nothing for a payload with no renderable field", () => {
    expect(summarizeEvent(event(1, "x", { nested: { a: 1 } }))).toBe("")
    expect(summarizeEvent(event(1, "x"))).toBe("")
  })
})
