import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { BackgroundJob } from "@miao/core/background-job"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionBackgroundJobs } from "@miao/core/session/background-jobs"
import { SessionDelegationStore } from "@miao/core/session/delegation-store"
import { SessionEvent } from "@miao/core/session/event"
import { SessionMessage } from "@miao/core/session/message"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const setup = Effect.gen(function* () {
  const session = yield* SessionV2.Service
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const created = yield* session.create({ location })
  const announce = (status: string, text = "record", metadata: Record<string, unknown> = {}) =>
    events.publish(SessionEvent.Synthetic, {
      sessionID: created.id,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.makeUnsafe(1000),
      text,
      metadata: { backgroundJob: { id: "job_test", command: "do work", status, ...metadata } },
    })
  const settle = (text: string, metadata: Record<string, unknown> = {}) =>
    events.publish(SessionEvent.NotificationAdmitted, {
      sessionID: created.id,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.makeUnsafe(2000),
      text,
      metadata: { backgroundJob: { id: "job_test", command: "do work", status: "finished", ...metadata } },
    })
  return { session, db, events, created, announce, settle }
})

describe("Session background-job recovery", () => {
  it.effect("read-only observation reports missing jobs without publishing recovery or touching another owner", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("started")
      const other = yield* test.session.create({ location })
      const jobs = yield* BackgroundJob.make
      yield* jobs.start({ id: "job_other", type: "bash", metadata: { sessionID: other.id }, run: Effect.never })
      const owned = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id, jobs })
      expect(yield* owned.observe()).toMatchObject([
        { id: "job_test", status: "error", error: expect.stringContaining("outcome is unknown") },
      ])
      expect(yield* test.session.context(test.created.id)).toHaveLength(1)
      expect((yield* jobs.get("job_other"))?.status).toBe("running")
    }),
  )

  it.effect("recovers an untracked start as unknown-outcome error once, without restarting it", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("started", "started", { outputPath: "/captured.log" })
      const executions = { count: 0 }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* BackgroundJob.make
          yield* old.start({
            id: "job_test",
            type: "bash",
            metadata: { sessionID: test.created.id },
            run: Effect.sync(() => {
              executions.count++
            }).pipe(Effect.andThen(Effect.never)),
          })
        }),
      )
      const before = executions.count
      const jobs = yield* BackgroundJob.make
      const recovered = SessionBackgroundJobs.make({
        db: test.db,
        events: test.events,
        sessionID: test.created.id,
        jobs,
      })
      expect(yield* recovered.list()).toMatchObject([
        { id: "job_test", status: "error", error: expect.stringContaining("outcome is unknown") },
      ])
      expect((yield* recovered.wait("job_test")).timedOut).toBe(false)
      expect(yield* recovered.cancel("job_test")).toMatchObject({ status: "error" })
      expect(executions.count).toBe(before)
      expect(yield* jobs.list()).toEqual([])
      const context = yield* test.session.context(test.created.id)
      expect(context).toHaveLength(2)
      expect(context[1]).toMatchObject({ type: "synthetic", text: expect.stringContaining("/captured.log") })
    }),
  )

  it.effect("does not misclassify a still-live job and preserves owner isolation", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("started")
      const other = yield* test.session.create({ location })
      const jobs = yield* BackgroundJob.make
      yield* jobs.start({ id: "job_test", type: "bash", metadata: { sessionID: test.created.id }, run: Effect.never })
      const owned = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id, jobs })
      const isolated = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: other.id, jobs })
      expect(yield* owned.list()).toMatchObject([{ status: "running" }])
      expect(yield* isolated.list()).toEqual([])
      expect((yield* isolated.wait("job_test")).info).toBeUndefined()
      expect(yield* isolated.cancel("job_test")).toBeUndefined()
      expect((yield* jobs.get("job_test"))?.status).toBe("running")
      expect(yield* test.session.context(test.created.id)).toHaveLength(1)
      expect((yield* owned.cancel("job_test"))?.status).toBe("cancelled")
      yield* test.announce("finished", "late finish notification")
      const afterRestart = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
      expect(yield* afterRestart.list()).toMatchObject([{ status: "cancelled" }])
    }),
  )

  it.effect("keeps finished observations available after restart and without a process registry", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("started")
      yield* test.announce("finished", "[exit code 0]")
      const recovered = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
      expect(yield* recovered.list()).toMatchObject([
        { id: "job_test", status: "completed", started_at: 1000, output: "[exit code 0]" },
      ])
      expect((yield* recovered.wait("job_test")).info?.status).toBe("completed")
      expect(yield* test.session.context(test.created.id)).toHaveLength(2)
    }),
  )

  it.effect("ignores malformed lifecycle metadata", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("not-a-status")
      const recovered = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
      expect(yield* recovered.list()).toEqual([])
    }),
  )

  it.effect("merges a settled job admitted as a notification and keeps the transcript clean until promotion", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("started")
      yield* test.settle("Background job job_test finished.\n[exit code 0]", { outputPath: "/captured.log" })
      const recovered = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
      expect(yield* recovered.list()).toMatchObject([
        {
          id: "job_test",
          status: "completed",
          started_at: 1000,
          output: "Background job job_test finished.\n[exit code 0]",
          metadata: { outputPath: "/captured.log" },
        },
      ])
      expect(yield* test.session.context(test.created.id)).toHaveLength(1)
      expect(yield* SessionDelegationStore.hasPromotableNotifications(test.db, test.created.id)).toBe(true)
      expect(yield* SessionDelegationStore.promoteNext(test.db, test.events, test.created.id)).toBe(true)
      expect(yield* SessionDelegationStore.hasPromotableNotifications(test.db, test.created.id)).toBe(false)
      const context = yield* test.session.context(test.created.id)
      expect(context).toHaveLength(2)
      expect(context[1]).toMatchObject({
        type: "synthetic",
        text: "Background job job_test finished.\n[exit code 0]",
        metadata: { backgroundJob: { id: "job_test", status: "finished" } },
      })
      expect(yield* recovered.list()).toMatchObject([{ status: "completed" }])
    }),
  )
})
