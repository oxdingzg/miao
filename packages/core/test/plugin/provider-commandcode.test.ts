import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { LayerNodePlatform } from "@miao/core/effect/app-node-platform"
import { Integration } from "@miao/core/integration"
import { ModelV2 } from "@miao/core/model"
import { ModelsDev } from "@miao/core/models-dev"
import { PluginV2 } from "@miao/core/plugin"
import { PluginHost } from "@miao/core/plugin/host"
import { CommandCodePlugin } from "@miao/core/plugin/provider/commandcode"
import { ProviderV2 } from "@miao/core/provider"
import { testEffect } from "../lib/effect"
import { pluginTestLayer } from "./fixture"

const PROVIDER_ID = ProviderV2.ID.make("commandcode")
const INTEGRATION_ID = Integration.ID.make("commandcode")
const modelID = (id: string) => ModelV2.ID.make(id)

// `GET /provider/v1/models` is public and plan-agnostic: it lists every model,
// including the Max-only ones, whatever plan the key is on. It reports ids and
// limits only, never capabilities.
const live = JSON.stringify({
  data: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", context_length: 1_000_000 },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context_length: 1_000_000 },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context_length: 1_000_000 },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1_000_000 },
    // Not in the catalog yet, so it carries no plan info and no modalities.
    { id: "brand/new-model", name: "Brand New", context_length: 200_000 },
  ],
})

// The miao-owned catalog names the plan tiers that include each model, and
// carries the input modalities the Provider API omits.
const devCatalog = {
  commandcode: {
    id: "commandcode",
    name: "Command Code",
    env: ["CMD_API_KEY"],
    api: "https://api.commandcode.ai",
    models: {
      "claude-opus-5-5": { id: "claude-opus-5-5", plans: ["max"] },
      "claude-sonnet-5-5": { id: "claude-sonnet-5-5", plans: ["goat", "pro", "max"] },
      "deepseek/deepseek-v4-pro": { id: "deepseek/deepseek-v4-pro", plans: ["go", "goat", "pro", "max"] },
      "deepseek/deepseek-v4.1-flash": {
        id: "deepseek/deepseek-v4.1-flash",
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
} as unknown as Record<string, ModelsDev.Provider>

const modelsDev = ModelsDev.Service.of({
  get: () => Effect.succeed(devCatalog),
  refresh: () => Effect.void,
})

const http = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(live, { status: 200 }))),
)

const it = testEffect(
  Layer.fresh(pluginTestLayer([[LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, http)]])),
)

const seed = Effect.fn(function* () {
  const catalog = yield* Catalog.Service
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  yield* credentials.create({
    integrationID: INTEGRATION_ID,
    value: Credential.Key.make({ type: "key", key: "cmd-key" }),
  })
  yield* integrations.transform((draft) => {
    draft.update(INTEGRATION_ID, (integration) => (integration.name = "Command Code"))
  })
  yield* catalog.transform((draft) => {
    draft.provider.update(PROVIDER_ID, (provider) => {
      provider.integrationID = INTEGRATION_ID
      provider.api = { type: "native", url: "https://api.commandcode.ai", settings: {} }
    })
  })
})

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* CommandCodePlugin.effect(host).pipe(Effect.provideService(ModelsDev.Service, modelsDev))
})

const withPlan = <A, E, R>(plan: string | undefined, self: Effect.Effect<A, E, R>) => {
  const previous = process.env["MIAO_COMMANDCODE_PLAN"]
  if (plan === undefined) delete process.env["MIAO_COMMANDCODE_PLAN"]
  else process.env["MIAO_COMMANDCODE_PLAN"] = plan
  return self.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env["MIAO_COMMANDCODE_PLAN"]
        else process.env["MIAO_COMMANDCODE_PLAN"] = previous
      }),
    ),
  )
}

const available = Effect.fn(function* () {
  const catalog = yield* Catalog.Service
  return (yield* catalog.model.available()).filter((model) => model.providerID === PROVIDER_ID).map((model) => model.id)
})

describe("CommandCodePlugin", () => {
  it.effect("hides models the connected account's plan cannot call", () =>
    withPlan(
      "pro",
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* seed()
        yield* addPlugin()
        // Max-only Opus is hidden, Pro-and-above Sonnet is kept.
        expect((yield* catalog.model.get(PROVIDER_ID, modelID("claude-opus-5-5")))?.enabled).toBe(false)
        expect((yield* catalog.model.get(PROVIDER_ID, modelID("claude-sonnet-5-5")))?.enabled).toBe(true)
        // A model absent from the catalog has no plan info, so it stays visible.
        expect(yield* available()).toEqual([
          modelID("claude-sonnet-5-5"),
          modelID("deepseek/deepseek-v4-pro"),
          modelID("deepseek/deepseek-v4.1-flash"),
          modelID("brand/new-model"),
        ])
      }),
    ),
  )

  it.effect("keeps every model on the Max plan", () =>
    withPlan(
      "max",
      Effect.gen(function* () {
        yield* seed()
        yield* addPlugin()
        expect(yield* available()).toEqual([
          modelID("claude-opus-5-5"),
          modelID("claude-sonnet-5-5"),
          modelID("deepseek/deepseek-v4-pro"),
          modelID("deepseek/deepseek-v4.1-flash"),
          modelID("brand/new-model"),
        ])
      }),
    ),
  )

  it.effect("keeps every model when the plan is unknown", () =>
    withPlan(
      undefined,
      Effect.gen(function* () {
        yield* seed()
        yield* addPlugin()
        expect(yield* available()).toHaveLength(5)
      }),
    ),
  )

  it.effect("keeps every model for a plan tier the catalog does not gate on", () =>
    withPlan(
      "provider",
      Effect.gen(function* () {
        yield* seed()
        yield* addPlugin()
        expect(yield* available()).toHaveLength(5)
      }),
    ),
  )

  it.effect("borrows the catalog's input modalities for a known model id", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seed()
      yield* addPlugin()
      expect(
        (yield* catalog.model.get(PROVIDER_ID, modelID("deepseek/deepseek-v4.1-flash")))?.capabilities.input,
      ).toEqual(["text", "image"])
    }),
  )

  it.effect("stays text-only for an id the catalog does not carry", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seed()
      yield* addPlugin()
      expect((yield* catalog.model.get(PROVIDER_ID, modelID("brand/new-model")))?.capabilities.input).toEqual(["text"])
    }),
  )
})
