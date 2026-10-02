import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@miao/core/agent"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { LocationServiceMap } from "@miao/core/location-services"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionTable } from "@miao/core/session/sql"
import { ShellEnvironment } from "@miao/core/shell/environment"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { ToolRegistry } from "@miao/core/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const inputs: ShellEnvironment.Input[] = []

// A host installs its source into the shared layer once, outside any Location,
// the way the miao server installs plugin `shell.env` hooks.
const host = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* ShellEnvironment.Service
    yield* environment.install((input) =>
      Effect.sync(() => {
        inputs.push(input)
        return { MIAO_FROM_HOST: "host-value" }
      }),
    )
  }),
).pipe(Layer.provide(ShellEnvironment.layer))

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
    ),
    host,
  ),
)

describe("ShellEnvironment", () => {
  ;(process.platform === "win32" ? it.live.skip : it.live)(
    "reaches the bash tool of every Location from one host installation",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const sessionID = SessionV2.ID.make("ses_shell_environment")
            const settled = yield* Effect.gen(function* () {
              const location = yield* Location.Service
              const database = yield* Database.Service
              yield* database.db
                .insert(ProjectTable)
                .values({ id: location.project.id, worktree: location.project.directory, sandboxes: [] })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              yield* database.db
                .insert(SessionTable)
                .values({
                  id: sessionID,
                  project_id: location.project.id,
                  slug: "shell-environment",
                  directory: dir.path,
                  title: "shell environment",
                  version: "test",
                  agent: "build",
                })
                .run()
                .pipe(Effect.orDie)
              const agents = yield* AgentV2.Service
              yield* agents.transform((editor) =>
                editor.update(AgentV2.ID.make("build"), (agent) => {
                  agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
                }),
              )
              return yield* settleTool(yield* ToolRegistry.Service, {
                sessionID,
                ...toolIdentity,
                call: {
                  type: "tool-call" as const,
                  id: "call-shell-environment",
                  name: "bash",
                  input: { command: 'echo "$MIAO_FROM_HOST"' },
                },
              })
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
              ),
            )
            const result = settled.result
            const text =
              result.type === "content"
                ? result.value.map((part) => (part.type === "text" ? part.text : "")).join("\n")
                : String(result.value)
            expect(text).toContain("host-value")
            expect(inputs.at(-1)).toMatchObject({ directory: dir.path, sessionID, callID: "call-shell-environment" })
          }),
        ),
      ),
  )
})
