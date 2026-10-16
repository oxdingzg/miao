import { describe, expect, test } from "bun:test"
import { ModelSwitch } from "@miao/core/session/model-switch"

describe("ModelSwitch.text", () => {
  test("names both models and labels the previous report as historical", () => {
    const text = ModelSwitch.text({ from: "openai/gpt-6.1-sol", to: "zhipu/glm-5.3-flash", observedTokens: 238_000, context: 1_000_000 })
    expect(text).toContain("switched from openai/gpt-6.1-sol to zhipu/glm-5.3-flash")
    expect(text).toContain("last successful provider request used about 24% of the configured context window (238000 of 1000000 tokens)")
    expect(text).toContain("historical report, not a count of the next request")
    expect(text).toContain("is a reason to stop")
  })

  test("drops the usage sentence when no real number exists", () => {
    const text = ModelSwitch.text({ from: "a", to: "b", observedTokens: 0, context: 0 })
    expect(text).not.toContain("last successful provider request")
    expect(text).toContain("switched from a to b")
    expect(text).toContain("is a reason to stop")
  })
})
