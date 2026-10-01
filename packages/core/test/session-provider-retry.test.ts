import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { AuthenticationReason, InvalidRequestReason, LLMError, RateLimitReason, TransportReason } from "@miao/llm"
import { DateTime, Effect, Fiber, Ref } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { LocationServiceMap } from "@miao/core/location-services"
import { Location } from "@miao/core/location"
import { ModelV2 } from "@miao/core/model"
import { PluginV2 } from "@miao/core/plugin"
import { ProviderV2 } from "@miao/core/provider"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { SessionRunnerProviderRetry } from "@miao/core/session/runner/provider-retry"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { tmpdir } from "./fixture/tmpdir"
import { it, testEffect } from "./lib/effect"

const providerError = (reason: LLMError["reason"]) => new LLMError({ module: "test", method: "test", reason })

const locationIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("SessionRunnerProviderRetry", () => {
  test("retries catalog misses and transient provider failures", () => {
    expect(SessionRunnerProviderRetry.retryable({ _tag: "SessionRunnerModel.ModelUnavailableError" })).toBe(true)
    expect(SessionRunnerProviderRetry.retryable({ _tag: "SessionRunnerModel.ModelNotSelectedError" })).toBe(true)
    expect(
      SessionRunnerProviderRetry.retryable(providerError(new RateLimitReason({ message: "slow down" }))),
    ).toBe(true)
    expect(
      SessionRunnerProviderRetry.retryable(
        providerError(new AuthenticationReason({ message: "expired", kind: "expired" })),
      ),
    ).toBe(true)
    expect(
      SessionRunnerProviderRetry.retryable(
        providerError(new TransportReason({ message: "connection reset", kind: "stream-read" })),
      ),
    ).toBe(true)
  })

  test("does not retry failures a retry cannot fix", () => {
    expect(
      SessionRunnerProviderRetry.retryable(providerError(new InvalidRequestReason({ message: "bad request" }))),
    ).toBe(false)
    expect(
      SessionRunnerProviderRetry.retryable(
        providerError(new AuthenticationReason({ message: "free tier", kind: "insufficient-permissions" })),
      ),
    ).toBe(false)
    expect(
      SessionRunnerProviderRetry.retryable(
        providerError(new TransportReason({ message: "connect refused", kind: "TransportError" })),
      ),
    ).toBe(false)
    expect(SessionRunnerProviderRetry.retryable({ _tag: "SessionRunnerModel.UnsupportedApiError" })).toBe(false)
    expect(SessionRunnerProviderRetry.retryable({ _tag: "Other" })).toBe(false)
  })

  it.live("retries a retryable provider failure", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.gen(function* () {
        yield* Ref.update(attempts, (count) => count + 1)
        return yield* providerError(new RateLimitReason({ message: "again" }))
      })

      const fiber = yield* failing.pipe(
        Effect.retry({
          while: (error) => SessionRunnerProviderRetry.retryable(error),
          schedule: SessionRunnerProviderRetry.providerSchedule,
        }),
        Effect.forkScoped,
      )

      yield* Effect.sleep("2 seconds")
      expect(yield* Ref.get(attempts)).toBeGreaterThan(1)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("fails immediately when a retry cannot help", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.gen(function* () {
        yield* Ref.update(attempts, (count) => count + 1)
        return yield* providerError(new InvalidRequestReason({ message: "bad request" }))
      })

      const exit = yield* failing.pipe(
        Effect.retry({
          while: (error) => SessionRunnerProviderRetry.retryable(error),
          schedule: SessionRunnerProviderRetry.providerSchedule,
        }),
        Effect.exit,
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})

describe("SessionRunnerProviderRetry against a live location", () => {
  locationIt.live("recovers a model that becomes available while retrying", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "miao.json"),
              JSON.stringify({
                providers: {
                  slow: {
                    name: "Slow",
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const session = SessionV2.Info.make({
            id: SessionV2.ID.make("ses_provider_retry"),
            projectID: ProjectV2.ID.global,
            title: "retry",
            model: { id: ModelV2.ID.make("chat"), providerID: ProviderV2.ID.make("slow") },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location,
          })

          yield* Effect.gen(function* () {
            const models = yield* SessionRunnerModel.Service
            const rejected = yield* models
              .resolve(session)
              .pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)
            expect(rejected).toMatchObject({
              _tag: "SessionRunnerModel.ModelUnavailableError",
              providerID: "slow",
              modelID: "chat",
            })

            // A credential or plugin settling publishes the model mid-retry.
            yield* Effect.gen(function* () {
              const plugins = yield* PluginV2.Service
              yield* Effect.sleep("400 millis")
              yield* plugins.add(PluginV2.ID.make("enable-slow"), (ctx) =>
                ctx.catalog.transform((evt) => {
                  evt.model.update(ProviderV2.ID.make("slow"), ModelV2.ID.make("chat"), (model) => {
                    model.enabled = true
                  })
                }),
              )
            }).pipe(Effect.forkScoped)

            const resolved = yield* models.resolve(session).pipe(
              Effect.retry({
                while: (error) => SessionRunnerProviderRetry.retryable(error),
                schedule: SessionRunnerProviderRetry.catalogSchedule,
              }),
            )
            expect(resolved).toMatchObject({ model: { id: "chat", provider: "slow" } })
          }).pipe(
            Effect.scoped,
            Effect.provide(LocationServiceMap.Service.get(location)),
          )
        }),
      ),
    ),
  )

  locationIt.live("retries a session that has no model of its own", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "miao.json"),
              JSON.stringify({
                experimental: {
                  // Every other provider is removed, so what this test resolves
                  // is the `slow` provider alone, and not whichever provider the
                  // machine running the suite happens to be logged into.
                  policies: [
                    { effect: "deny", action: "provider.use", resource: "*" },
                    { effect: "allow", action: "provider.use", resource: "slow" },
                  ],
                },
                providers: {
                  slow: {
                    name: "Slow",
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          // The shape `session.fork`, subagent creation, and a `session.create`
          // without a model all produce.
          const session = SessionV2.Info.make({
            id: SessionV2.ID.make("ses_provider_retry_default"),
            projectID: ProjectV2.ID.global,
            title: "retry default",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location,
          })

          yield* Effect.gen(function* () {
            const models = yield* SessionRunnerModel.Service
            const rejected = yield* models
              .resolve(session)
              .pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)
            expect(rejected).toMatchObject({ _tag: "SessionRunnerModel.ModelNotSelectedError", sessionID: session.id })

            // A cold location's catalog is empty for the same reason this one is
            // empty of available models: the plugins that build it have not run
            // yet. The turn has to wait that window out instead of failing it.
            yield* Effect.gen(function* () {
              const plugins = yield* PluginV2.Service
              yield* Effect.sleep("400 millis")
              yield* plugins.add(PluginV2.ID.make("enable-slow"), (ctx) =>
                ctx.catalog.transform((evt) => {
                  evt.model.update(ProviderV2.ID.make("slow"), ModelV2.ID.make("chat"), (model) => {
                    model.enabled = true
                  })
                }),
              )
            }).pipe(Effect.forkScoped)

            const resolved = yield* models.resolve(session).pipe(
              Effect.retry({
                while: (error) => SessionRunnerProviderRetry.retryable(error),
                schedule: SessionRunnerProviderRetry.catalogSchedule,
              }),
            )
            expect(resolved).toMatchObject({ model: { id: "chat", provider: "slow" } })
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )
})
