import { Config } from "@miao/core/config"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { bootedCatalog, response } from "../location"

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
function toModel(model: ModelV2.Info) {
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
function toProvider(provider: ProviderV2.Info, models: ReadonlyArray<ModelV2.Info>) {
  return {
    id: provider.id,
    name: provider.name,
    source: "config" as const,
    env: [] as string[],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, toModel(model)])),
  }
}

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle(
      "config.get",
      Effect.fn(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        return yield* response(Effect.succeed(Config.merge(entries)))
      }),
    )
    .handle(
      "config.providers",
      Effect.fn(function* () {
        const catalog = yield* bootedCatalog
        const providers = yield* catalog.provider.available()
        const models = yield* catalog.model.available()
        // Core exposes one global default rather than a per-provider default, so
        // mirror V1 `defaultModelIDs` intent: apply the global default to its own
        // provider and use the newest available model for every other provider.
        const fallback = yield* catalog.model.default()
        const defaultModelIDs: Record<string, string> = {}
        const result = providers.map((provider) => {
          const available = models.filter((model) => model.providerID === provider.id)
          const preferred =
            fallback && fallback.providerID === provider.id
              ? available.find((model) => model.id === fallback.id)
              : undefined
          const chosen = preferred ?? available[0]
          if (chosen) defaultModelIDs[provider.id] = chosen.id
          return toProvider(provider, available)
        })
        return yield* response(Effect.succeed({ providers: result, default: defaultModelIDs }))
      }),
    ),
)
