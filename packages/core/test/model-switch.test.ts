import { describe, expect, test } from "bun:test"
import { ModelSwitch } from "@miao/core/session/model-switch"

describe("ModelSwitch.text", () => {
  test("names both models and attaches the real usage", () => {
    const text = ModelSwitch.text({ from: "openai/gpt-6.1-sol", to: "zhipu/glm-5.3-flash", observedTokens: 238_000, context: 1_000_000 })
    expect(text).toContain("switched from openai/gpt-6.1-sol to zhipu/glm-5.3-flash")
    expect(text).toContain("about 24% of the model context window is in use (238000 of 1000000 tokens)")
    expect(text).toContain("is a reason to stop")
  })

  test("drops the usage sentence when no real number exists", () => {
    const text = ModelSwitch.text({ from: "a", to: "b", observedTokens: 0, context: 0 })
    expect(text).not.toContain("Context status")
    expect(text).toContain("switched from a to b")
    expect(text).toContain("is a reason to stop")
  })
})
