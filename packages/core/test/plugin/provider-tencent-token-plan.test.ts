import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { LayerNodePlatform } from "@miao/core/effect/app-node-platform"
import { Integration } from "@miao/core/integration"
import { ModelV2 } from "@miao/core/model"
import { PluginV2 } from "@miao/core/plugin"
import { PluginHost } from "@miao/core/plugin/host"
import { ProviderPlugins } from "@miao/core/plugin/provider"
import { TencentTokenPlanPlugin } from "@miao/core/plugin/provider/tencent-token-plan"
import { TencentTokenPlan } from "@miao/core/tencent-token-plan"
import { ProviderV2 } from "@miao/core/provider"
import { testEffect } from "../lib/effect"
import { pluginTestLayer } from "./fixture"

const planID = ProviderV2.ID.make("tencent-token-plan")
const unconnectedID = ProviderV2.ID.make("tencent-token-plan-unconnected")
const otherID = ProviderV2.ID.make("other")
const PKG = "@ai-sdk/openai-compatible"
const modelID = (id: string) => ModelV2.ID.make(id)

// What `GET {api}/models` answers for a key scoped to these models: Hy3 is a
// models.dev entry this key cannot call, so using it answers 403002.
const plan = JSON.stringify({ data: [{ id: "hy4-preview" }, { id: "glm-5.2" }, { id: "deepseek/deepseek-flash" }] })

type Calls = { readonly status: number; readonly urls: Array<string>; readonly authorization: Array<string> }

const suite = (input: { readonly key: string; readonly status?: number }) => {
  const calls = Ref.makeUnsafe<Calls>({ status: input.status ?? 200, urls: [], authorization: [] })
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(calls)
      yield* Ref.set(calls, {
        ...current,
        urls: [...current.urls, request.url],
        authorization: [...current.authorization, request.headers["authorization"] ?? ""],
      })
      return HttpClientResponse.fromWeb(request, new Response(plan, { status: current.status }))
    }),
  )
  return {
    key: input.key,
    // A distinct credential per suite: the store is shared, and
    // `authorizedModels` caches per base URL and key for the process.
    integrationID: Integration.ID.make(`suite-${input.key}`),
    calls,
    it: testEffect(
      Layer.fresh(pluginTestLayer([[LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, http)]])),
    ),
  }
}

const reachable = suite({ key: "reachable-key" })
const failing = suite({ key: "failing-key", status: 500 })
const late = suite({ key: "late-key" })

// The plugin asks the gateway beside the catalog, so a test has to wait for the
// reload that answer triggers instead of asserting right after boot.
const eventually = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 1000,
): Effect.Effect<A, Error> =>
  Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* TencentTokenPlanPlugin.effect(host)
})

const addPlanModels = (draft: Catalog.Draft, providerID: ProviderV2.ID) => {
  draft.model.update(providerID, modelID("hy3"), (model) => {
    model.api = { type: "aisdk", id: modelID("hy3"), package: PKG }
  })
  draft.model.update(providerID, modelID("hy4-preview"), (model) => {
    model.api = { type: "aisdk", id: modelID("hy4-preview"), package: PKG }
  })
  draft.model.update(providerID, modelID("flash"), (model) => {
    model.api = { type: "aisdk", id: modelID("deepseek/deepseek-flash"), package: PKG }
  })
}

const seed = Effect.fn(function* (input: { readonly integrationID: Integration.ID; readonly key?: string }) {
  const catalog = yield* Catalog.Service
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  if (input.key !== undefined) {
    yield* credentials.create({
      integrationID: input.integrationID,
      value: Credential.Key.make({ type: "key", key: input.key }),
    })
  }
  // The models.dev plugin registers an integration for every provider that
  // declares env vars, which is what makes the provider available to list.
  yield* integrations.transform((draft) => {
    draft.update(input.integrationID, (integration) => {
      integration.name = "Tencent Token Plan"
    })
  })
  yield* catalog.transform((draft) => {
    draft.provider.update(planID, (provider) => {
      provider.integrationID = input.integrationID
      provider.api = { type: "aisdk", package: PKG, url: TencentTokenPlan.API }
    })
    addPlanModels(draft, planID)
    draft.provider.update(unconnectedID, (provider) => {
      provider.integrationID = Integration.ID.make("unconnected")
      provider.api = { type: "aisdk", package: PKG, url: TencentTokenPlan.API }
    })
    addPlanModels(draft, unconnectedID)
    draft.provider.update(otherID, (provider) => {
      provider.api = { type: "aisdk", package: PKG, url: "https://api.example.com/v1" }
    })
    draft.model.update(otherID, modelID("hy3"), (model) => {
      model.api = { type: "aisdk", id: modelID("hy3"), package: PKG }
    })
  })
})

describe("TencentTokenPlanPlugin", () => {
  reachable.it.effect("is registered so the catalog hides models the plan key cannot call", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain(PluginV2.ID.make("tencent-token-plan"))),
  )

  reachable.it.effect("drops the catalog models the plan key is not scoped for", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seed({ integrationID: reachable.integrationID, key: reachable.key })
      yield* addPlugin()
      yield* eventually(catalog.model.get(planID, modelID("hy3")), (model) => model === undefined)

      expect((yield* catalog.model.get(planID, modelID("hy4-preview")))?.id).toBe(modelID("hy4-preview"))
      // Authorized through the ID it sends, not the catalog ID it is listed as.
      expect((yield* catalog.model.get(planID, modelID("flash")))?.id).toBe(modelID("flash"))
      // A provider on the plan gateway with no connected credential is left alone.
      expect((yield* catalog.model.get(unconnectedID, modelID("hy3")))?.id).toBe(modelID("hy3"))
      // A provider pointed at another gateway is left alone.
      expect((yield* catalog.model.get(otherID, modelID("hy3")))?.id).toBe(modelID("hy3"))

      const calls = yield* Ref.get(reachable.calls)
      expect(calls.urls).toEqual([`${TencentTokenPlan.API}/models`])
      expect(calls.authorization).toEqual([`Bearer ${reachable.key}`])
      expect((yield* catalog.model.available()).filter((model) => model.providerID === planID)).toHaveLength(2)
    }),
  )

  failing.it.effect("keeps every model when the gateway cannot answer", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seed({ integrationID: failing.integrationID, key: failing.key })
      yield* addPlugin()
      yield* eventually(Ref.get(failing.calls), (calls) => calls.urls.length === 1)

      expect((yield* catalog.model.get(planID, modelID("hy3")))?.id).toBe(modelID("hy3"))
    }),
  )

  late.it.effect("hides the models of a key connected to a running process", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integration = yield* Integration.Service
      yield* seed({ integrationID: late.integrationID })
      yield* integration.transform((draft) => {
        draft.method.update({ integrationID: late.integrationID, method: { type: "key", label: "API key" } })
      })
      yield* addPlugin()
      // Without a key there is no answer to act on, and nothing to ask.
      expect((yield* catalog.model.get(planID, modelID("hy3")))?.id).toBe(modelID("hy3"))
      expect((yield* Ref.get(late.calls)).urls).toEqual([])

      yield* integration.connection.key({ integrationID: late.integrationID, key: late.key })
      yield* eventually(catalog.model.get(planID, modelID("hy3")), (model) => model === undefined)
    }),
  )
})
