export * as ModelVariants from "./model-variants"

import type { ModelV2Info } from "@opencode-ai/sdk/v2/types"

/** A model's declared reasoning controls, as published by the catalog. */
export type ReasoningOption =
  | { readonly type: "effort"; readonly values: ReadonlyArray<string | null> }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number }

type Api = {
  readonly id: string
  readonly type: string
  readonly package?: string
}

/**
 * Packages whose reasoning body this module can write at the wire level. Other
 * protocols express effort differently (Anthropic sends `thinking`), so they
 * keep whatever the provider declares instead of a guess.
 */
const supportsReasoningBody = (api: Api) =>
  api.package === "@ai-sdk/openai" || api.package === "@ai-sdk/openai-compatible"

const effortVariants = (api: Api, values: ReadonlyArray<string | null>): ModelV2Info["variants"] =>
  values.map((value) => {
    // A null entry is the catalog's "none": no effort, not an absent value.
    const id = value ?? "none"
    return {
      id,
      headers: {},
      body: api.package === "@ai-sdk/openai" ? { reasoning: { effort: id } } : { reasoning_effort: id },
    }
  })

/**
 * Variants derived from the model's declared reasoning options. Only `effort`
 * carries the wire field this module needs; `toggle` and `budget_tokens` name
 * no field in the catalog, so they contribute nothing.
 */
export function fromReasoningOptions(input: {
  readonly api: Api
  readonly options?: ReadonlyArray<ReasoningOption>
}): ModelV2Info["variants"] {
  if (input.api.type !== "aisdk" || !supportsReasoningBody(input.api)) return []
  const effort = input.options?.find((option) => option.type === "effort")
  if (effort?.type !== "effort") return []
  return effortVariants(input.api, effort.values)
}

/** Reasoning families whose own catalog entry is not always the one in use. */
const COMPATIBLE_REASONING = [
  // GLM-5.2 exposes high/max through an OpenAI-compatible reasoning_effort.
  { names: ["glm-5.2", "glm-5-2", "glm-5p2"], efforts: ["high", "max"] },
  // DeepSeek documents low/high/max for thinking models.
  { names: ["deepseek-flash", "deepseek-v4"], efforts: ["low", "high", "max"] },
]

export function generate(model: {
  readonly id: string
  readonly api: Api
}): ModelV2Info["variants"] {
  if (model.api.type !== "aisdk") return []
  if (model.api.package === "@ai-sdk/openai" && /(?:^|\/)(?:gpt-[5-9](?:[.-]|$)|o[134](?:[.-]|$))/.test(model.api.id)) {
    return effortVariants(model.api, ["low", "medium", "high"])
  }
  if (model.api.package !== "@ai-sdk/openai-compatible") return []
  // A plan or gateway provider can expose a model under its own id, where the
  // catalog's reasoning options are not reachable. Match the family name so
  // those deployments still offer the tiers their upstream documents.
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  const family = COMPATIBLE_REASONING.find((entry) => entry.names.some((name) => ids.includes(name)))
  if (family === undefined) return []
  return effortVariants(model.api, family.efforts)
}
