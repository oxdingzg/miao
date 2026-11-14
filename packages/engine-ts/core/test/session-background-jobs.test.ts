import { SessionBackfill } from "@miao/core/session/backfill"
import { BackgroundJobTool } from "@miao/core/tool/background-job"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
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
import { SessionTable } from "@miao/core/session/sql"
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

describe("Session notification delivery", () => {
  it.effect("promotes a completed batch for one wake unit without losing individual reports", () =>
    Effect.gen(function* () {
      const test = yield* setup
      for (const text of ["first result", "second result", "third result"]) yield* test.settle(text)
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(3)
      expect(yield* SessionDelegationStore.wakeAllowance(test.db, test.created.id)).toBe(
        SessionDelegationStore.WAKE_BUDGET - 1,
      )
      expect(yield* SessionDelegationStore.pendingCount(test.db, test.created.id)).toBe(0)
      expect(
        (yield* test.session.context(test.created.id))
          .filter((message) => message.type === "synthetic")
          .map((message) => message.text),
      ).toEqual(["first result", "second result", "third result"])
    }),
  )

  it.effect("bounds batch count and charges only once for each provider-turn snapshot", () =>
    Effect.gen(function* () {
      const test = yield* setup
      for (let i = 0; i < 9; i++) yield* test.settle(`result-${i}`)
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(8)
      expect(yield* SessionDelegationStore.pendingCount(test.db, test.created.id)).toBe(1)
      expect(yield* SessionDelegationStore.wakeAllowance(test.db, test.created.id)).toBe(
        SessionDelegationStore.WAKE_BUDGET - 1,
      )
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(1)
      expect(yield* SessionDelegationStore.wakeAllowance(test.db, test.created.id)).toBe(
        SessionDelegationStore.WAKE_BUDGET - 2,
      )
    }),
  )

  it.effect("bounds batch bytes while retaining FIFO delivery for the remaining reports", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.settle("a".repeat(40 * 1024))
      yield* test.settle("b".repeat(40 * 1024))
      yield* test.settle("last")
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(1)
      expect(yield* SessionDelegationStore.pendingCount(test.db, test.created.id)).toBe(2)
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(2)
      const history = (yield* test.session.context(test.created.id)).filter((message) => message.type === "synthetic")
      expect(history.map((message) => message.text[0])).toEqual(["a", "b", "l"])
    }),
  )

  it.effect("honors the admission cutoff and consumes at most one queued tick per idle boundary", () =>
    Effect.gen(function* () {
      const test = yield* setup
      const admit = (text: string, delivery: "queue" | "steer") =>
        test.events.publish(SessionEvent.NotificationAdmitted, {
          sessionID: test.created.id,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(2000),
          text,
          metadata: { delivery },
        })
      yield* admit("queue-1", "queue")
      yield* admit("steer-1", "steer")
      const cutoff = yield* EventV2.latestSequence(test.db, test.created.id)
      yield* admit("queue-2", "queue")
      yield* admit("steer-2", "steer")
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id, false, cutoff)).toBe(1)
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(1)
      expect(
        (yield* test.session.context(test.created.id))
          .filter((message) => message.type === "synthetic")
          .map((message) => message.text),
      ).toEqual(["steer-1", "queue-1"])
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(2)
      expect(yield* SessionDelegationStore.pendingCount(test.db, test.created.id)).toBe(0)
    }),
  )

  it.effect("only one batch can spend the final wake unit", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.settle("completed-a")
      yield* test.settle("completed-b")
      yield* test.db
        .update(SessionTable)
        .set({ wake_allowance: 1 })
        .where(eq(SessionTable.id, test.created.id))
        .run()
        .pipe(Effect.orDie)
      const results = yield* Effect.all(
        [
          SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id),
          SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.reduce((sum, count) => sum + count, 0)).toBe(2)
      expect(yield* SessionDelegationStore.wakeAllowance(test.db, test.created.id)).toBe(0)
      expect(
        (yield* test.session.context(test.created.id)).filter((message) => message.type === "synthetic"),
      ).toHaveLength(2)
    }),
  )

  it.effect("records one explicit pause per unread backlog and resumes retained outcomes after recharge", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.settle("saved result")
      yield* test.db
        .update(SessionTable)
        .set({ wake_allowance: 0 })
        .where(eq(SessionTable.id, test.created.id))
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(0)
      expect(yield* SessionDelegationStore.pauseIfExhausted(test.db, test.events, test.created.id)).toBe(true)
      yield* test.settle("another saved result")
      expect(yield* SessionDelegationStore.pauseIfExhausted(test.db, test.events, test.created.id)).toBe(true)
      const history = (yield* test.session.context(test.created.id)).filter((message) => message.type === "synthetic")
      expect(history).toHaveLength(1)
      expect(history[0].text).toContain("Automatic continuation paused")
      expect(history[0].metadata?.notificationPause).toMatchObject({
        reason: "wake-allowance-exhausted",
        pendingAtPause: 1,
      })
      expect(yield* SessionDelegationStore.pendingCount(test.db, test.created.id)).toBe(2)
      yield* SessionDelegationStore.recharge(test.db, test.created.id)
      expect(yield* SessionDelegationStore.promoteBatch(test.db, test.events, test.created.id)).toBe(2)
      expect(yield* SessionDelegationStore.pauseIfExhausted(test.db, test.events, test.created.id)).toBe(false)
      expect(yield* SessionDelegationStore.pendingCount(test.db, test.created.id)).toBe(0)
    }),
  )
})

describe("Session background-job recovery", () => {
  it.effect("failed settlements stay failed after promotion and without a live registry", () =>
    Effect.gen(function* () {
      const test = yield* setup
      yield* test.announce("started")
      yield* test.settle("Background job job_test failed.\n[exit code 7]", { status: "failed", error: "exit code 7" })
      const recovered = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
      expect(yield* recovered.observe()).toMatchObject([{ status: "error", error: "exit code 7", completed_at: 2000 }])
      expect(yield* SessionDelegationStore.promoteNext(test.db, test.events, test.created.id)).toBe(true)
      expect(yield* recovered.observe()).toMatchObject([{ status: "error", error: "exit code 7" }])
    }),
  )

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

it.effect("durable background observations retain an unknown start after a known settlement", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const message = SessionMessage.Synthetic.make({
      id: SessionMessage.ID.create(),
      sessionID: test.created.id,
      type: "synthetic",
      text: "historical start",
      time: { created: null },
      metadata: { backgroundJob: { id: "job_test", command: "do work", status: "started" } },
    })
    yield* test.db.transaction((tx) => SessionBackfill.write(tx, test.created.id, [message]))
    const observed = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
    expect(yield* observed.observe()).toMatchObject([{ started_at: null }])
    yield* test.settle("Recorded completion")
    const jobs = yield* observed.observe()
    expect(jobs).toMatchObject([{ started_at: null, completed_at: 2000, status: "completed" }])
    expect(Schema.decodeUnknownSync(BackgroundJobTool.JobInfo)(jobs[0]).started_at).toBeNull()
  }),
)

it.effect("a settlement with no start record does not manufacture its start from the completion clock", () =>
  Effect.gen(function* () {
    const test = yield* setup
    yield* test.settle("Recorded completion")
    const observed = SessionBackgroundJobs.make({ db: test.db, events: test.events, sessionID: test.created.id })
    expect(yield* observed.observe()).toMatchObject([{ started_at: null, completed_at: 2000, status: "completed" }])
  }),
)
