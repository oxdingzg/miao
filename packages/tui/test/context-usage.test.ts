import { remainingContext } from "../src/util/context-usage"
import { expect, test } from "bun:test"
import type { SessionMessageAssistant } from "@miao/schema/view-models"
import { contextLabel, contextUsage } from "../src/util/context-usage"

const successful: SessionMessageAssistant = {
  id: "msg_success",
  type: "assistant",
  agent: "build",
  model: null,
  content: [],
  time: { created: 1, completed: 2 },
  finish: "stop",
  tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 900, write: 50 } },
}
const pending: SessionMessageAssistant = {
  id: "msg_pending",
  type: "assistant",
  agent: "build",
  model: null,
  content: [],
  time: { created: 3 },
  contextBudget: { input: 80_000, source: "estimated", window: 100_000, limit: 70_000 },
}

test("pending request uses its own budget, including cached input in the historical count", () => {
  expect(contextUsage([successful, pending])).toMatchObject({
    observed: 1050,
    tokens: 80_000,
    percent: 80,
    rejected: false,
  })
  expect(contextLabel([successful, pending], String)).toBe("~80000 (80%)")
})

test("rejected requests do not show the previous successful count as current occupancy", () => {
  const failed = {
    ...pending,
    finish: "error",
    error: { type: "unknown" as const, message: "context_length_exceeded" },
  }
  expect(contextUsage([successful, failed])).toMatchObject({ observed: 1050, rejected: true })
  expect(contextUsage([successful, failed]).percent).toBeUndefined()
  expect(contextUsage([successful, failed]).tokens).toBeUndefined()
  expect(contextLabel([successful, failed], String)).toBe("request failed")
})

test("historical sessions label the previous report explicitly and unknown windows have no percent", () => {
  expect(contextLabel([successful], String)).toBe("last 1050")
  expect(contextLabel([], String)).toBeUndefined()
  const counted = { ...pending, contextBudget: { input: 80_000, limit: 70_000, source: "counted" as const, window: 0 } }
  expect(contextLabel([counted], String)).toBe("80000")
})

test("compaction invalidates the displayed request estimate", () => {
  const messages = [
    successful,
    pending,
    {
      type: "compaction" as const,
      id: "msg_checkpoint",
      reason: "auto" as const,
      summary: "checkpoint",
      recent: "",
      time: { created: 4 },
    },
  ]
  expect(contextLabel(messages, String)).toBe("compacted")
  expect(contextUsage(messages).percent).toBeUndefined()
})

test("status line reports remaining capacity and keeps unknown or failed requests unmeasured", () => {
  expect(remainingContext([successful, pending])).toEqual({ label: "Context ~20% left", remaining: 20 })
  expect(remainingContext([])).toEqual({ label: "Context —", remaining: undefined })
  expect(remainingContext([successful])).toEqual({ label: "Context —", remaining: undefined })
  expect(remainingContext([{ ...pending, error: { type: "unknown", message: "rejected" } }]).remaining).toBeUndefined()
  expect(
    remainingContext([
      { ...pending, contextBudget: { input: 120_000, source: "estimated", window: 100_000, limit: 70_000 } },
    ]).remaining,
  ).toBe(0)
})
