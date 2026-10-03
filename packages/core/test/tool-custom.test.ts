import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { tool } from "@miao/plugin/tool"
import { AgentV2 } from "@miao/core/agent"
import { Config } from "@miao/core/config"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { CustomTools } from "@miao/core/tool/custom"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const fixture = AbsolutePath.make(path.resolve(import.meta.dir, "fixture/custom-tools"))
// This repository's own `.miao` directory ships two custom tools.
const repository = AbsolutePath.make(path.resolve(import.meta.dir, "../../../.miao"))
const sessionID = SessionV2.ID.make("ses_custom_tools")
const agent = AgentV2.ID.make("custom-test")
const allowAll: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]

const withCustomTools = <A, E, R>(
  directories: AbsolutePath[],
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  rules = allowAll,
) => {
  const entries = directories.map((directory) => new Config.Directory({ type: "directory", path: directory }))
  const built = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      ToolPlugins.node,
      CustomTools.node,
      ToolRegistry.toolsNode,
      ToolRegistry.node,
      ApplicationTools.node,
      ToolOutputStore.node,
    ]),
    [
      [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: fixture })))],
    ],
  )
  return Effect.gen(function* () {
    yield* setup(rules)
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(built))
}

const setup = (rules: PermissionV2.Ruleset) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: fixture, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "custom",
        directory: fixture,
        title: "custom",
        version: "test",
        agent,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(agent, (item) => {
        item.permissions = [...rules]
      }),
    )
  })

const names = (registry: ToolRegistry.Interface, rules?: PermissionV2.Ruleset) =>
  registry.materialize(rules).pipe(Effect.map((materialized) => materialized.definitions.map((item) => item.name)))

const run = (registry: ToolRegistry.Interface, name: string, input: Record<string, unknown> = {}) =>
  registry.materialize().pipe(
    Effect.flatMap((materialized) =>
      materialized.settle({
        sessionID,
        agent,
        assistantMessageID: SessionMessage.ID.make("msg_custom"),
        call: { type: "tool-call", id: `call-${name}`, name, input },
      }),
    ),
    Effect.map((settlement) => settlement.result),
  )

describe("CustomTools", () => {
  it.live("loads {tool,tools}/*.ts from config directories and names exports like V1", () =>
    withCustomTools([fixture], (registry) =>
      Effect.gen(function* () {
        expect(yield* names(registry)).toEqual(["greet", "greet_secret"])
        const materialized = yield* registry.materialize()
        expect(materialized.definitions[0]?.inputSchema).toMatchObject({
          type: "object",
          properties: { name: { type: "string", description: "Who to greet" } },
          required: ["name"],
        })
      }),
    ),
  )

  it.live("loads this repository's .miao custom tools", () =>
    withCustomTools([repository], (registry) =>
      Effect.gen(function* () {
        expect(yield* names(registry)).toEqual(["github-pr-search", "github-triage"])
      }),
    ),
  )

  it.live("executes a custom tool with the V1 tool context", () =>
    withCustomTools([fixture], (registry) =>
      Effect.gen(function* () {
        expect(yield* run(registry, "greet", { name: "miao" })).toEqual({
          type: "text",
          value: `hello miao from custom-test in ${fixture}`,
        })
        expect((yield* run(registry, "greet", { name: 1 })).type).toBe("error")
      }),
    ),
  )

  it.live("hides a custom tool that a rule denies outright", () =>
    withCustomTools([fixture], (registry) =>
      Effect.gen(function* () {
        expect(yield* names(registry, [...allowAll, { action: "greet", resource: "*", effect: "deny" }])).toEqual([
          "greet_secret",
        ])
      }),
    ),
  )

  it.live("routes the tool's own context.ask through PermissionV2", () =>
    withCustomTools(
      [fixture],
      (registry) =>
        Effect.gen(function* () {
          const result = yield* run(registry, "greet_secret")
          expect(result.type).toBe("error")
          expect(String(result.value)).toContain("prevents you from using this specific tool call")
        }),
      [...allowAll, { action: "greet-secret", resource: "vault", effect: "deny" }],
    ),
  )

  it.live("asserts PermissionV2 under the tool name before running it", () =>
    withCustomTools(
      [fixture],
      (registry) =>
        Effect.gen(function* () {
          // A resource-scoped deny keeps the tool advertised but blocks the call itself.
          const result = yield* run(registry, "greet", { name: "miao" })
          expect(result.type).toBe("error")
          expect(String(result.value)).toContain("prevents you from using this specific tool call")
        }),
      [
        ...allowAll,
        { action: "greet", resource: "*", effect: "deny" },
        // The last matching rule is not a whole-tool deny, so the tool stays visible.
        { action: "greet", resource: "never", effect: "allow" },
      ],
    ),
  )

  it.live("registers plugin-provided tools until the plugin disposes them", () =>
    withCustomTools([], (registry) =>
      Effect.gen(function* () {
        const plugins = yield* ToolPlugins.Service
        const scope = yield* Scope.make()
        yield* plugins
          .provide({
            "plugin-echo": tool({
              description: "Echo from a plugin",
              args: { text: tool.schema.string() },
              execute: async (args) => `plugin:${args.text}`,
            }),
          })
          .pipe(Scope.provide(scope))

        expect(yield* names(registry)).toEqual(["plugin-echo"])
        expect(yield* run(registry, "plugin-echo", { text: "hi" })).toEqual({ type: "text", value: "plugin:hi" })

        yield* Scope.close(scope, Exit.void)
        expect(yield* names(registry)).toEqual([])
      }),
    ),
  )
})
