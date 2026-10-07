import { describe, expect } from "bun:test"
import { Deferred, DateTime, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { EventV2 } from "@miao/core/event"
import { Integration } from "@miao/core/integration"
import { Location } from "@miao/core/location"
import { ModelV2 } from "@miao/core/model"
import { PluginV2 } from "@miao/core/plugin"
import { Policy } from "@miao/core/policy"
import { ProviderV2 } from "@miao/core/provider"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { SessionV2 } from "@miao/core/session"
import { location } from "./fixture/location"
import { it } from "./lib/effect"

// A Location populates its catalog while the plugin boot runs, so a resolve
// racing that boot must wait for `PluginV2.booted` instead of reporting the
// model gone. The stub keeps that signal as a gate the tests complete by hand.
const gate: { current: Deferred.Deferred<void> | undefined } = { current: undefined }

const gatedPluginLayer = Layer.effect(
  PluginV2.Service,
  Effect.gen(function* () {
    const booted = yield* Deferred.make<void>()
    gate.current = booted
    return PluginV2.Service.of({
      booted,
      add: () => Effect.void,
      remove: () => Effect.void,
      wait: () => Effect.void,
    })
  }),
)

const providerID = ProviderV2.ID.make("lookup")
const modelID = ModelV2.ID.make("selected")

const populate = (catalog: Catalog.Interface) =>
  catalog.transform((editor) => {
    editor.provider.update(providerID, (provider) => {
      provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://lookup.example/v1" }
      provider.request.body.apiKey = "test-key"
    })
    editor.model.update(providerID, modelID, (model) => {
      model.enabled = true
      model.name = "Selected"
      model.time.released = 0
    })
  })

const session = (model: { providerID: ProviderV2.ID; id: ModelV2.ID } | undefined) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make("ses_cold_catalog"),
    projectID: ProjectV2.ID.global,
    title: "cold catalog",
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/project") },
  })

const layer = () =>
  Layer.fresh(
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
        [PluginV2.node, gatedPluginLayer],
      ],
    ),
  )

describe("model resolve against a booting catalog", () => {
  it.live(
    "waits for the plugin boot before reporting a pinned model unavailable",
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const catalog = yield* Catalog.Service
      const fiber = yield* models.resolve(session({ providerID, id: modelID })).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      yield* populate(catalog)
      if (!gate.current) throw new Error("missing the boot gate")
      yield* Deferred.succeed(gate.current, undefined)
      const resolved = yield* Fiber.join(fiber)
      expect(resolved.info.providerID).toBe(providerID)
      expect(resolved.info.id).toBe(modelID)
    }).pipe(Effect.scoped, Effect.provide(layer())),
  )

  it.live(
    "resolves a session without a model once the boot fills the catalog",
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const catalog = yield* Catalog.Service
      const fiber = yield* models.resolve(session(undefined)).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      yield* populate(catalog)
      if (!gate.current) throw new Error("missing the boot gate")
      yield* Deferred.succeed(gate.current, undefined)
      const resolved = yield* Fiber.join(fiber)
      expect(resolved.info.providerID).toBe(providerID)
      expect(resolved.info.id).toBe(modelID)
    }).pipe(Effect.scoped, Effect.provide(layer())),
  )

  it.live(
    "reports a pinned model unavailable at once once the boot has completed",
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      if (!gate.current) throw new Error("missing the boot gate")
      yield* Deferred.succeed(gate.current, undefined)
      const rejected = yield* models.resolve(session({ providerID, id: modelID })).pipe(Effect.flip)
      expect(rejected._tag).toBe("SessionRunnerModel.ModelUnavailableError")
      if (rejected._tag === "SessionRunnerModel.ModelUnavailableError") {
        expect(rejected.providerID).toBe(providerID)
        expect(rejected.modelID).toBe(modelID)
      }
    }).pipe(Effect.scoped, Effect.provide(layer())),
  )
})
