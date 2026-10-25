import { describe, expect, test } from "bun:test"
import { contextTimeline, type UsageStep } from "./session-context-timeline-model"

const step = (id: string, time: number, model = "small"): UsageStep => ({
  id,
  messageID: "msg_shared",
  time,
  model: { providerID: "provider", id: model },
  finish: "stop",
  cost: 0.01,
  tokens: { input: 100, output: 900, reasoning: 500, cache: { read: 200, write: 50 } },
})

describe("contextTimeline", () => {
  test("stacks only input and cache tokens and leaves an unknown window unknown", () => {
    const segments = contextTimeline([step("one", 1)], [], new Map())
    expect(segments[0].points[0].input).toBe(350)
    expect(segments[0].points[0].window).toBeUndefined()
    expect(segments[0].axis).toBe(350)
  })

  test("uses independent scales after a model/window change and keeps a distant window off-axis", () => {
    const segments = contextTimeline(
      [step("one", 1), step("two", 2, "large")],
      [],
      new Map([
        [JSON.stringify(["provider", "small"]), 400],
        [JSON.stringify(["provider", "large"]), 1_000_000],
      ]),
    )
    expect(segments.map((segment) => segment.axis)).toEqual([400, 350])
    expect(segments[1].window).toBe(1_000_000)
    expect(segments[1].source).toBe("catalog")
  })

  test("does not reuse a message's final measured budget for its earlier provider steps", () => {
    const segments = contextTimeline(
      [step("one", 1), step("two", 2)],
      [
        {
          id: "msg_shared",
          type: "assistant",
          agent: "build",
          model: { providerID: "provider", id: "small" },
          content: [],
          contextBudget: { input: 350, source: "counted", window: 600, limit: 500 },
          time: { created: 0, completed: 2 },
        },
      ],
      new Map(),
    )
    expect(segments[0].points[0].window).toBeUndefined()
    expect(segments[1].points[0].window).toBe(600)
    expect(segments[1].source).toBe("request")
  })

  test("marks compaction only in the interval containing its recorded timestamp", () => {
    const segments = contextTimeline(
      [step("one", 100), step("two", 300), step("three", 400)],
      [
        {
          id: "msg_compaction",
          type: "compaction",
          reason: "auto",
          summary: "summary",
          recent: "recent",
          time: { created: 200 },
        },
      ],
      new Map(),
    )
    expect(segments[0].points.map((point) => point.compacted)).toEqual([false, true, false])
  })

  test("does not attribute a newer completed request budget to an older usage page", () => {
    const segments = contextTimeline(
      [step("older", 1)],
      [
        {
          id: "msg_shared",
          type: "assistant",
          agent: "build",
          model: { providerID: "provider", id: "small" },
          content: [],
          contextBudget: { input: 350, source: "counted", window: 600, limit: 500 },
          time: { created: 0, completed: 2 },
        },
      ],
      new Map(),
    )
    expect(segments[0].window).toBeUndefined()
    expect(segments[0].source).toBeUndefined()
  })
})
