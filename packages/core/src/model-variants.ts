export * as ModelVariants from "./model-variants"

import type { ModelV2Info } from "@opencode-ai/sdk/v2/types"

export function generate(model: {
  readonly id: string
  readonly api: { readonly id: string; readonly type: string; readonly package?: string }
}): ModelV2Info["variants"] {
  if (model.api.type !== "aisdk") return []
  if (model.api.package === "@ai-sdk/openai" && /(?:^|\/)(?:gpt-[5-9](?:[.-]|$)|o[134](?:[.-]|$))/.test(model.api.id)) {
    return ["low", "medium", "high"].map((id) => ({ id, headers: {}, body: { reasoning: { effort: id } } }))
  }
  if (model.api.package !== "@ai-sdk/openai-compatible") return []
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  if (!["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return []
  return ["high", "max"].map((id) => ({
    id,
    headers: {},
    body: { reasoning_effort: id },
  }))
}
