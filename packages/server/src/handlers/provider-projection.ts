import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"

function modalities(values: ReadonlyArray<string>) {
  return {
    text: values.includes("text"),
    audio: values.includes("audio"),
    image: values.includes("image"),
    video: values.includes("video"),
    pdf: values.includes("pdf"),
  }
}

// V2 stores cost as an array whose head is the base rate and whose tail carries
// context tiers; the V1 client shape splits those into `cost` plus `tiers`.
function cost(model: ModelV2.Info) {
  const [base = { input: 0, output: 0, cache: { read: 0, write: 0 } }, ...tiers] = model.cost
  const tiered = tiers.flatMap((item) =>
    item.tier ? [{ input: item.input, output: item.output, cache: item.cache, tier: item.tier }] : [],
  )
  return {
    input: base.input,
    output: base.output,
    cache: base.cache,
    ...(tiered.length ? { tiers: tiered } : {}),
  }
}

// Project a V2 model onto the V1 model shape the TUI store keeps. The V2 model
// carries no temperature or interleaved flags, so those are best-effort:
// reasoning is inferred from the presence of request variants.
export function toModel(model: ModelV2.Info) {
  return {
    id: model.id,
    providerID: model.providerID,
    api: {
      id: model.api.id,
      url: model.api.url ?? "",
      npm: model.api.type === "aisdk" ? model.api.package : "",
    },
    name: model.name,
    ...(model.family ? { family: model.family } : {}),
    capabilities: {
      temperature: true,
      reasoning: model.variants.length > 0,
      attachment: model.capabilities.input.some((item) => item !== "text"),
      toolcall: model.capabilities.tools,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output),
      interleaved: false,
    },
    cost: cost(model),
    limit: model.limit,
    status: model.status,
    options: {},
    headers: {},
    release_date: new Date(model.time.released).toISOString(),
    ...(model.variants.length
      ? { variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.body])) }
      : {}),
  }
}

// The V2 catalog splits providers and models, while the V1 response nests the
// provider's models under it; V2 has no connection source, so it always reports
// `config`.
export function toProvider(provider: ProviderV2.Info, models: ReadonlyArray<ModelV2.Info>) {
  return {
    id: provider.id,
    name: provider.name,
    source: "config" as const,
    env: [] as string[],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, toModel(model)])),
  }
}

// Join the V2 catalog's flat model list back onto its providers and project both
// onto the legacy V1 shape.
export function projectProviders(providers: ReadonlyArray<ProviderV2.Info>, models: ReadonlyArray<ModelV2.Info>) {
  return providers.map((provider) =>
    toProvider(
      provider,
      models.filter((model) => model.providerID === provider.id),
    ),
  )
}

// Core exposes one global default rather than a per-provider default, so mirror
// V1 `defaultModelIDs` intent: apply the global default to its own provider and
// use the newest available model for every other provider.
export function defaultModelIDs(
  providers: ReadonlyArray<ProviderV2.Info>,
  models: ReadonlyArray<ModelV2.Info>,
  fallback: ModelV2.Info | undefined,
) {
  const result: Record<string, string> = {}
  for (const provider of providers) {
    const available = models.filter((model) => model.providerID === provider.id)
    const preferred =
      fallback && fallback.providerID === provider.id ? available.find((model) => model.id === fallback.id) : undefined
    const chosen = preferred ?? available[0]
    if (chosen) result[provider.id] = chosen.id
  }
  return result
}
