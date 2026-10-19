export * as ModelVariants from "./model-variants"

import type { ModelV2Info } from "@miao/schema/view-models"

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
const supportsReasoningBody = (api: { readonly package?: string }) =>
  api.package === "@ai-sdk/openai" || api.package === "@ai-sdk/openai-compatible"

const effortVariants = (api: Api, values: ReadonlyArray<string | null>): ModelV2Info["variants"] =>
  values.map((value): ModelV2Info["variants"][number] => {
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

/**
 * Tiers an auxiliary call may fall back to, cheapest first. `none` is excluded:
 * it marks "no effort" in the catalog rather than a wire value every provider
 * accepts.
 */
const AUX_EFFORTS = ["minimal", "low"] as const

/**
 * Provider options that pin an auxiliary call — a title or a summary — to the
 * cheapest reasoning tier its model declares. Only packages whose reasoning
 * body this module can write are eligible, so the option never reaches a
 * protocol that would reject it, and a model declaring no tier gets none.
 */
export const auxReasoningOptions = (
  packageName: string | undefined,
  variants: ReadonlyArray<{ readonly id: string }>,
): Record<string, Record<string, unknown>> | undefined => {
  if (packageName === undefined || !supportsReasoningBody({ package: packageName })) return undefined
  const effort = AUX_EFFORTS.find((candidate) => variants.some((variant) => variant.id === candidate))
  return effort === undefined ? undefined : { [packageName]: { reasoningEffort: effort } }
}

/**
 * HTTP body overlay for the same pin. A model's selected variant lives in the
 * route's `http.body`, which is merged over the protocol body, so provider options
 * alone cannot override it. Only the model that owns the variant is eligible.
 */
export const auxReasoningBody = (
  api: { readonly package?: string },
  variants: ReadonlyArray<{ readonly id: string }>,
): Record<string, unknown> | undefined => {
  if (api.package === undefined || !supportsReasoningBody(api)) return undefined
  const effort = AUX_EFFORTS.find((candidate) => variants.some((variant) => variant.id === candidate))
  if (effort === undefined) return undefined
  return api.package === "@ai-sdk/openai" ? { reasoning: { effort } } : { reasoning_effort: effort }
}

/** Reasoning families whose own catalog entry is not always the one in use. */
const COMPATIBLE_REASONING = [
  // GLM-5.2 exposes high/max through an OpenAI-compatible reasoning_effort.
  { names: ["glm-5.2", "glm-5-2", "glm-5p2"], efforts: ["high", "max"] },
  // DeepSeek documents low/high/max for thinking models.
  { names: ["deepseek-flash", "deepseek-v4"], efforts: ["low", "high", "max"] },
]

export function generate(model: { readonly id: string; readonly api: Api }): ModelV2Info["variants"] {
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
