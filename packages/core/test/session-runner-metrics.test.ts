import { describe, expect, test } from "bun:test"
import { SessionRunnerMetrics } from "@miao/core/session/runner/metrics"

const usage = (input: number, read = 0, write = 0) => ({ input, cache: { read, write } })

describe("SessionRunnerMetrics", () => {
  test("reports the cached share of input tokens", () => {
    expect(SessionRunnerMetrics.cacheHitRatio(usage(1_000, 9_000))).toBeCloseTo(0.9, 10)
  })

  test("counts cache writes as misses", () => {
    expect(SessionRunnerMetrics.cacheHitRatio(usage(0, 0, 100))).toBe(0)
  })

  test("returns zero with no input tokens", () => {
    expect(SessionRunnerMetrics.cacheHitRatio(usage(0))).toBe(0)
  })

  test("reports an implicit cache miss when a cacheable prompt reads back nothing", () => {
    // OpenAI Chat, Responses and Gemini never report a cache write, so the only
    // signal that a warm prefix missed is a prompt with nothing read back.
    expect(SessionRunnerMetrics.cacheMissed(usage(5_000))).toBe(true)
    expect(SessionRunnerMetrics.cacheMissed(usage(5_000, 0, 0))).toBe(true)
  })

  test("counts a billed cache write as a miss whatever the read was", () => {
    expect(SessionRunnerMetrics.cacheMissed(usage(0, 0, 5_000))).toBe(true)
    expect(SessionRunnerMetrics.cacheMissed(usage(100, 5_000, 200))).toBe(true)
  })

  test("reports no miss for a hit, a prompt below the cacheable floor, or no usage", () => {
    expect(SessionRunnerMetrics.cacheMissed(usage(0, 5_000))).toBe(false)
    expect(SessionRunnerMetrics.cacheMissed(usage(300))).toBe(false)
    expect(SessionRunnerMetrics.cacheMissed(usage(0))).toBe(false)
  })

  test("classifies cache misses by cause", () => {
    const cause = SessionRunnerMetrics.cacheMissCause
    expect(cause({ miss: false, warm: true, expectedRebuild: false })).toBe("none")
    expect(cause({ miss: true, warm: false, expectedRebuild: false })).toBe("cold")
    expect(cause({ miss: true, warm: true, expectedRebuild: true })).toBe("rebuild")
    expect(cause({ miss: true, warm: false, expectedRebuild: true })).toBe("rebuild")
    expect(cause({ miss: true, warm: true, expectedRebuild: false })).toBe("prefix-change")
  })
})
