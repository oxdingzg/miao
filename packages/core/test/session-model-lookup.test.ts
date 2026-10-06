import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { EventV2 } from "@miao/core/event"
import { Integration } from "@miao/core/integration"
import { Location } from "@miao/core/location"
import { ModelV2 } from "@miao/core/model"
import { Policy } from "@miao/core/policy"
import { ProviderV2 } from "@miao/core/provider"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { SessionV2 } from "@miao/core/session"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Catalog.node,
      Credential.node,
      EventV2.node,
      Integration.node,
      Policy.node,
      SessionRunnerModel.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("test") }))),
      ],
    ],
  ),
)

const providerID = ProviderV2.ID.make("lookup")
const modelID = ModelV2.ID.make("selected")
const session = SessionV2.Info.make({
  id: SessionV2.ID.make("ses_model_lookup"),
  projectID: ProjectV2.ID.global,
  title: "lookup",
  model: { providerID, id: modelID },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory: AbsolutePath.make("/project") },
})

const populate = (catalog: Catalog.Interface, count = 0) =>
  catalog.transform((editor) => {
    editor.provider.update(providerID, (provider) => {
      provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://lookup.example/v1" }
      provider.request.body.apiKey = "test-key"
      provider.request.headers["x-provider"] = "one"
    })
    editor.model.update(providerID, modelID, (model) => {
      model.enabled = true
      model.request.headers["x-model"] = "selected"
    })
    Array.from({ length: count }, (_, index) => {
      const id = ProviderV2.ID.make(`other-${index}`)
      editor.provider.update(id, (provider) => {
        provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://other.example/v1" }
      })
      Array.from({ length: 25 }, (_, index) =>
        editor.model.update(id, ModelV2.ID.make(`model-${index}`), (model) => {
          model.enabled = true
          model.time.released = index
        }),
      )
    })
  })

describe("selected Session model lookup", () => {
  it.effect("keeps provider/model overlays fresh and refuses disabled or removed selections", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const models = yield* SessionRunnerModel.Service
      yield* populate(catalog)
      expect((yield* models.resolve(session)).model.route.defaults.headers).toMatchObject({
        "x-provider": "one",
        "x-model": "selected",
      })
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.request.headers["x-provider"] = "two"
        }),
      )
      expect((yield* models.resolve(session)).model.route.defaults.headers?.["x-provider"]).toBe("two")
      yield* catalog.transform((editor) =>
        editor.model.update(providerID, modelID, (model) => {
          model.enabled = false
        }),
      )
      expect((yield* models.resolve(session).pipe(Effect.flip))._tag).toBe("SessionRunnerModel.ModelUnavailableError")
      yield* catalog.transform((editor) => {
        editor.model.update(providerID, modelID, (model) => {
          model.enabled = true
        })
        editor.provider.update(providerID, (provider) => {
          provider.disabled = true
        })
      })
      expect((yield* models.resolve(session).pipe(Effect.flip))._tag).toBe("SessionRunnerModel.ModelUnavailableError")
      yield* catalog.transform((editor) => editor.provider.remove(providerID))
      expect((yield* models.resolve(session).pipe(Effect.flip))._tag).toBe("SessionRunnerModel.ModelUnavailableError")
    }),
  )

  it.effect("rechecks the selected integration after credential creation and revocation", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const models = yield* SessionRunnerModel.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("selected-gateway")
      yield* integrations.transform((editor) => editor.update(integrationID, () => {}))
      yield* populate(catalog)
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
          delete provider.request.body.apiKey
        }),
      )
      expect(yield* catalog.model.getAvailable(providerID, modelID)).toBeUndefined()
      expect((yield* models.resolve(session).pipe(Effect.flip))._tag).toBe("SessionRunnerModel.ModelUnavailableError")
      const credential = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "live-key" }),
      })
      const available = (yield* catalog.model.available()).find(
        (model) => model.providerID === providerID && model.id === modelID,
      )
      if (!available) throw new Error("Expected the newly authenticated model")
      expect(yield* catalog.model.getAvailable(providerID, modelID)).toEqual(available)
      expect((yield* models.resolve(session)).info).toEqual(available)
      yield* credentials.remove(credential.id)
      expect(yield* catalog.model.getAvailable(providerID, modelID)).toBeUndefined()
      expect((yield* models.resolve(session).pipe(Effect.flip))._tag).toBe("SessionRunnerModel.ModelUnavailableError")
    }),
  )

  it.effect("matches the full catalog for optional auth and provider SDK settings keys", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("optional-gateway")
      yield* populate(catalog)
      yield* integrations.transform((editor) =>
        editor.method.update({ integrationID, method: { type: "key", optional: true } }),
      )
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
          delete provider.request.body.apiKey
        }),
      )
      expect(yield* catalog.model.getAvailable(providerID, modelID)).toEqual(
        (yield* catalog.model.available()).find((model) => model.providerID === providerID && model.id === modelID),
      )
      yield* integrations.transform((editor) => editor.method.remove(integrationID, { type: "key", optional: true }))
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://lookup.example/v1",
            settings: { apiKey: "settings-key" },
          }
        }),
      )
      expect(yield* catalog.model.getAvailable(providerID, modelID)).toEqual(
        (yield* catalog.model.available()).find((model) => model.providerID === providerID && model.id === modelID),
      )
      expect(yield* catalog.model.getAvailable(providerID, ModelV2.ID.make("absent"))).toBeUndefined()
    }),
  )

  if (process.env.MIAO_BENCHMARK_CATALOG === "1")
    it.live(
      "benchmarks the real resolver with 2,501 models",
      () =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const models = yield* SessionRunnerModel.Service
          yield* populate(catalog, 100)
          yield* Effect.forEach(Array.from({ length: 5 }), () => models.resolve(session), { discard: true })
          const samples = yield* Effect.forEach(Array.from({ length: 40 }), () =>
            Effect.gen(function* () {
              const start = performance.now()
              const resolved = yield* models.resolve(session)
              expect(resolved.info.id).toBe(modelID)
              return performance.now() - start
            }),
          )
          const sorted = samples.toSorted((a, b) => a - b)
          console.log(
            JSON.stringify({ models: 2501, n: samples.length, p50: sorted[19], p90: sorted[35], p99: sorted[39] }),
          )
        }),
      30_000,
    )
})
