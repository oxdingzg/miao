import { describe, expect, test } from "bun:test"
import { SessionRunnerMetrics } from "@miao/core/session/runner/metrics"

describe("SessionRunnerMetrics", () => {
  test("reports the cached share of input tokens", () => {
    expect(SessionRunnerMetrics.cacheHitRatio({ input: 1_000, cache: { read: 9_000, write: 0 } })).toBeCloseTo(0.9, 10)
  })

  test("counts cache writes as misses", () => {
    expect(SessionRunnerMetrics.cacheHitRatio({ input: 0, cache: { read: 0, write: 100 } })).toBe(0)
  })

  test("returns zero with no input tokens", () => {
    expect(SessionRunnerMetrics.cacheHitRatio({ input: 0, cache: { read: 0, write: 0 } })).toBe(0)
  })
})
