import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Equal, Hash, Option, Schema } from "effect"
import { BackgroundJob } from "@miao/core/background-job"
import { Tool } from "@miao/core/tool/tool"
import { define } from "@miao/plugin/v2/effect"
import { AgentV2 } from "@miao/core/agent"
import { Catalog } from "@miao/core/catalog"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { LocationServiceMap } from "@miao/core/location-services"
import { Location } from "@miao/core/location"
import { PluginV2 } from "@miao/core/plugin"
import { ModelV2 } from "@miao/core/model"
import { ProjectV2 } from "@miao/core/project"
import { ProviderV2 } from "@miao/core/provider"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { WorkspaceV2 } from "@miao/core/workspace"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsCatalog } from "../src/models-catalog"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { Reference } from "../src/reference"
import { fromRow } from "../src/session/info"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("LocationServiceMap", () => {
  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  it.live("resolves a projected session location to the same services as a request ref", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const row = {
              id: "ses_location_identity",
              project_id: "prj_location_identity",
              title: "identity",
              parent_id: null,
              agent: null,
              model: null,
              cost: 0,
              tokens_input: 0,
              tokens_output: 0,
              tokens_reasoning: 0,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
              directory: dir.path,
              path: null,
              time_created: 0,
              time_updated: 0,
              time_archived: null,
              revert: null,
            }
            // The HTTP session-location middleware builds the request ref this
            // way; the projected row must produce the exact same key shape or
            // the two resolve separate Location instances and split pending
            // question/permission state.
            const absent = fromRow({ ...row, workspace_id: null } as never).location
            const requestAbsent = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })

            expect(absent).toEqual(requestAbsent)
            expect(Reflect.ownKeys(absent)).toEqual(Reflect.ownKeys(requestAbsent))
            expect(yield* locations.contextEffect(absent)).toBe(yield* locations.contextEffect(requestAbsent))

            const present = fromRow({ ...row, workspace_id: "wrk_location_identity" } as never).location
            const requestPresent = Location.Ref.make({
              directory: AbsolutePath.make(dir.path),
              workspaceID: WorkspaceV2.ID.make("wrk_location_identity"),
            })

            expect(present).toEqual(requestPresent)
            expect(Reflect.ownKeys(present)).toEqual(Reflect.ownKeys(requestPresent))
            expect(yield* locations.contextEffect(present)).toBe(yield* locations.contextEffect(requestPresent))
          }),
        ),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "miao.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "cron_create",
            "cron_delete",
            "cron_list",
            "edit",
            "glob",
            "grep",
            "lsp",
            "monitor",
            "plan_enter",
            "plan_exit",
            "question",
            "read",
            "schedule_wakeup",
            "skill",
            "terminal_list",
            "terminal_read",
            "terminal_start",
            "terminal_stop",
            "terminal_write",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "cron_create",
            "cron_delete",
            "cron_list",
            "edit",
            "glob",
            "grep",
            "lsp",
            "monitor",
            "plan_enter",
            "plan_exit",
            "question",
            "read",
            "schedule_wakeup",
            "skill",
            "terminal_list",
            "terminal_read",
            "terminal_start",
            "terminal_stop",
            "terminal_write",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }),
      ),
    ),
  )

  it.live("classifies every built-in tool's concurrency", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const materialized = yield* (yield* ToolRegistry.Service).materialize()

          // Spelling out the class of every shipped tool is the point: a new
          // built-in fails here until someone decides whether it may overlap
          // the rest of its turn, and a class that changes by accident shows up
          // as a diff rather than as a race. Session-scoped tools are not in
          // this set; the runner tests cover those.
          expect(
            Object.fromEntries(materialized.definitions.map((tool) => [tool.name, materialized.concurrency(tool.name)])),
          ).toEqual({
            apply_patch: "exclusive",
            bash: "exclusive",
            cron_create: "exclusive",
            cron_delete: "exclusive",
            cron_list: "concurrent",
            edit: "exclusive",
            glob: "concurrent",
            grep: "concurrent",
            lsp: "concurrent",
            monitor: "exclusive",
            plan_enter: "exclusive",
            plan_exit: "exclusive",
            question: "exclusive",
            read: "concurrent",
            schedule_wakeup: "exclusive",
            skill: "concurrent",
            terminal_list: "concurrent",
            terminal_read: "exclusive",
            terminal_start: "exclusive",
            terminal_stop: "exclusive",
            terminal_write: "exclusive",
            todowrite: "exclusive",
            webfetch: "concurrent",
            websearch: "concurrent",
            write: "exclusive",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(
            LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
          ),
        ),
      ),
    ),
  )

  it.live("outputs process background jobs and events into a location's context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          // bash, monitor, and the runner read these ambiently at execution
          // time, so they are only visible when the Location layer itself
          // outputs them. Lose the location re-export nodes and every
          // run_in_background and monitor call fails with "not available in
          // this runtime" while unit tests that provide the services directly
          // stay green.
          const jobs = yield* Effect.serviceOption(BackgroundJob.Service)
          expect(Option.isSome(jobs)).toBe(true)
          const events = yield* Effect.serviceOption(EventV2.Service)
          expect(Option.isSome(events)).toBe(true)

          const listed = yield* Option.getOrThrowWith(
            jobs,
            () => new Error("BackgroundJob.Service is not provided to the location graph"),
          ).list()
          expect(listed).toEqual([])
        }).pipe(
          Effect.scoped,
          Effect.provide(
            LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
          ),
        ),
      ),
    ),
  )

  it.live("rejects an unavailable selected model during location model resolution", () =>
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
                  unavailable: {
                    name: "Unavailable",
                    api: { type: "native", settings: {} },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const failure = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_unavailable_model"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: {
                  id: ModelV2.ID.make("chat"),
                  providerID: ProviderV2.ID.make("unavailable"),
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.ModelUnavailableError",
            providerID: "unavailable",
            modelID: "chat",
          })
        }),
      ),
    ),
  )

  it.live("completes the plugin boot a catalog listing waits on", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          // The server's catalog listings wait here, so a boot that never
          // completed would hang them rather than fail them.
          yield* Deferred.await(plugins.booted).pipe(Effect.timeout("10 seconds"))
          // What the boot left behind is what a listing reads: this description
          // is set by the agent plugin the boot loads.
          expect((yield* (yield* AgentV2.Service).get(AgentV2.defaultID))?.description).toBe(
            "The default agent. Executes tools based on configured permissions.",
          )
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
