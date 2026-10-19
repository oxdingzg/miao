import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { LocationServiceMap, buildLocationServiceMap } from "@miao/core/location-services"
import { SessionRunner } from "@miao/core/session/runner"
import { node } from "@miao/core/session/runner/llm"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionEvent } from "@miao/core/session/event"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionExecutionLocal } from "@miao/core/session/execution/local"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
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
                  seen.push(status.type === "busy" ? `status:${status.phase ?? "preparing"}` : `status:${status.type}`)
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

const routed = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, SessionStore.node, SessionExecution.node]),
    [
      [SessionExecution.node, SessionExecutionLocal.node],
      [
        LocationServiceMap.node,
        buildLocationServiceMap([
          [
            node,
            Layer.succeed(
              SessionRunner.Service,
              SessionRunner.Service.of({
                run: () =>
                  Effect.gen(function* () {
                    const execution = yield* Effect.serviceOption(SessionExecution.Service)
                    expect(execution._tag).toBe("Some")
                    if (execution._tag === "None") return
                    expect(yield* execution.value.active).toEqual(new Set([SessionV2.ID.make("ses_execution_route")]))
                  }),
              }),
            ),
          ],
        ]),
      ],
    ],
  ),
)

routed.live("Location drains retain the active process-global execution service", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (dir) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const sessionID = SessionV2.ID.make("ses_execution_route")
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir.path), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: dir.path,
            title: "route",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const execution = yield* SessionExecution.Service
        yield* execution.resume(sessionID)
        expect(yield* execution.active).toEqual(new Set())
      }),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ),
)

it.live("native placement rejects TS resume and makes advisory wakes inert", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (dir) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const execution = yield* SessionExecution.Service
        const sessionID = SessionV2.ID.make("ses_execution_native")
        yield* SessionEnginePlacement.claim(database.db, {
          sessionID,
          placement: {
            engine: "rust",
            storage: AbsolutePath.make(`${dir.path}/native.db`),
            location: { directory: AbsolutePath.make(dir.path) },
          },
        })
        const before = yield* EventV2.latestSequence(database.db, sessionID)
        yield* execution.wake(sessionID)
        const resumed = yield* execution.resume(sessionID).pipe(Effect.exit)
        expect(resumed._tag).toBe("Failure")
        expect(yield* execution.active).toEqual(new Set())
        expect(yield* EventV2.latestSequence(database.db, sessionID)).toBe(before)
      }),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ),
)
