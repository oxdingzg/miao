import { expect, test } from "bun:test"
import { ModelVariants } from "@miao/core/model-variants"

const api = (packageName: string, id = "test-model") => ({ id, type: "aisdk", package: packageName })
const ids = (variants: ReturnType<typeof ModelVariants.generate>) => variants.map((variant) => variant.id)

test("catalog reasoning options become effort variants for an OpenAI-compatible model", () => {
  const variants = ModelVariants.fromReasoningOptions({
    api: api("@ai-sdk/openai-compatible", "deepseek-flash"),
    options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
  })

  expect(variants).toEqual([
    { id: "low", headers: {}, body: { reasoning_effort: "low" } },
    { id: "high", headers: {}, body: { reasoning_effort: "high" } },
    { id: "max", headers: {}, body: { reasoning_effort: "max" } },
  ])
})

test("catalog reasoning options name the Responses reasoning body for an OpenAI model", () => {
  const variants = ModelVariants.fromReasoningOptions({
    api: api("@ai-sdk/openai", "gpt-5.2"),
    options: [{ type: "effort", values: ["medium"] }],
  })

  expect(variants).toEqual([{ id: "medium", headers: {}, body: { reasoning: { effort: "medium" } } }])
})

test("a null effort value is the catalog's none", () => {
  const variants = ModelVariants.fromReasoningOptions({
    api: api("@ai-sdk/openai-compatible"),
    options: [{ type: "effort", values: [null, "high"] }],
  })

  expect(ids(variants)).toEqual(["none", "high"])
})

test("reasoning options without an effort value contribute no variant", () => {
  expect(
    ModelVariants.fromReasoningOptions({ api: api("@ai-sdk/openai-compatible"), options: [{ type: "toggle" }] }),
  ).toEqual([])
  expect(
    ModelVariants.fromReasoningOptions({
      api: api("@ai-sdk/openai-compatible"),
      options: [{ type: "budget_tokens", min: 1_000, max: 8_000 }],
    }),
  ).toEqual([])
  expect(ModelVariants.fromReasoningOptions({ api: api("@ai-sdk/openai-compatible") })).toEqual([])
})

test("a package whose reasoning body is unknown contributes no variant", () => {
  expect(
    ModelVariants.fromReasoningOptions({
      api: api("@ai-sdk/anthropic", "claude-opus-5"),
      options: [{ type: "effort", values: ["high"] }],
    }),
  ).toEqual([])
})

test("a DeepSeek thinking model offers its documented effort tiers without a catalog entry", () => {
  const variants = ModelVariants.generate({ id: "deepseek/deepseek-flash", api: api("@ai-sdk/openai-compatible", "deepseek/deepseek-flash") })

  expect(variants).toEqual([
    { id: "low", headers: {}, body: { reasoning_effort: "low" } },
    { id: "high", headers: {}, body: { reasoning_effort: "high" } },
    { id: "max", headers: {}, body: { reasoning_effort: "max" } },
  ])
})

test("an OpenAI GPT-5 class model keeps its effort variants", () => {
  expect(ids(ModelVariants.generate({ id: "gpt-5.2", api: api("@ai-sdk/openai", "gpt-5.2") }))).toEqual([
    "low",
    "medium",
    "high",
  ])
  expect(ModelVariants.generate({ id: "gpt-5.2", api: api("@ai-sdk/openai", "gpt-5.2") })[0]?.body).toEqual({
    reasoning: { effort: "low" },
  })
})

test("a model whose reasoning is not expressed as effort keeps no variant", () => {
  expect(ids(ModelVariants.generate({ id: "gpt-5.2", api: api("@ai-sdk/anthropic", "gpt-5.2") }))).toEqual([])
  expect(ids(ModelVariants.generate({ id: "some-model", api: api("@ai-sdk/openai-compatible") }))).toEqual([])
})
