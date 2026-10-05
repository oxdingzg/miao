import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { LocationServiceMap } from "@miao/core/location-services"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionEvent } from "@miao/core/session/event"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionExecutionLocal } from "@miao/core/session/execution/local"
import { MessageTable, SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Database.node,
      EventV2.node,
      LocationServiceMap.node,
      SessionStore.node,
      SessionExecution.node,
    ]),
    [[SessionExecution.node, SessionExecutionLocal.node]],
  ),
)

describe("SessionExecutionLocal", () => {
  it.live("publishes busy, the drain failure, then idle", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_execution_local")
          const { db } = yield* Database.Service
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir.path), sandboxes: [] })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Project.ID.global,
              slug: sessionID,
              directory: dir.path,
              title: "local",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          // History only in the V1 tables makes the drain fail before any provider step.
          yield* db
            .insert(MessageTable)
            .values({
              id: "msg_execution_local",
              session_id: sessionID,
              time_created: 1,
              time_updated: 1,
              data: { role: "user", time: { created: 1 }, agent: "build", model: { providerID: "x", modelID: "y" } },
            } as never)
            .run()
            .pipe(Effect.orDie)

          const events = yield* EventV2.Service
          const seen: string[] = []
          yield* events.all().pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === SessionEvent.Status.type) {
                  const status = (event.data as SessionEvent.Status["data"]).status
                  seen.push(
                    status.type === "busy" ? `status:${status.phase ?? "preparing"}` : `status:${status.type}`,
                  )
                }
                if (event.type === SessionEvent.Failed.type)
                  seen.push(`failed:${(event.data as SessionEvent.Failed["data"]).name}`)
              }),
            ),
            Effect.forkScoped,
          )
          yield* Effect.yieldNow

          const execution = yield* SessionExecution.Service
          yield* execution.resume(sessionID).pipe(Effect.exit)
          yield* Effect.sleep("10 millis")

          expect(seen).toEqual(["status:queued", "failed:Session.LegacyNotMigratedError", "status:idle"])
          expect(yield* execution.active).toEqual(new Set())
        }),
      ),
      Effect.scoped,
    ),
  )
})
