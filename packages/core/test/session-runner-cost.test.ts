import { describe, expect, test } from "bun:test"
import { Usage } from "@miao/llm"
import { ModelV2 } from "@miao/core/model"
import { SessionRunnerCost } from "@miao/core/session/runner/cost"

const rates = (input: number, output: number, read: number, write: number): ModelV2.Info["cost"][number] => ({
  input,
  output,
  cache: { read, write },
})

describe("SessionRunnerCost", () => {
  test("prices non-cached input, visible output, reasoning, and cache tokens", () => {
    const cost = SessionRunnerCost.of(
      [rates(1, 2, 0.1, 1.25)],
      new Usage({
        inputTokens: 13_000,
        nonCachedInputTokens: 1_000,
        outputTokens: 600,
        reasoningTokens: 100,
        cacheReadInputTokens: 10_000,
        cacheWriteInputTokens: 2_000,
      }),
    )

    expect(cost).toBeCloseTo(0.0057, 10)
  })

  test("uses the largest matching context tier", () => {
    const base = rates(1, 1, 0, 0)
    const tier = { ...rates(10, 20, 0, 0), tier: { type: "context" as const, size: 200_000 } }
    const usage = new Usage({ inputTokens: 250_000, nonCachedInputTokens: 250_000, outputTokens: 1_000 })

    expect(SessionRunnerCost.of([base, tier], usage)).toBeCloseTo((250_000 * 10 + 1_000 * 20) / 1_000_000, 10)
  })

  test("returns zero without cost rates", () => {
    expect(SessionRunnerCost.of([], new Usage({ inputTokens: 100 }))).toBe(0)
  })
})
