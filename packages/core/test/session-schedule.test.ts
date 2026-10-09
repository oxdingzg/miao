import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Layer, Option } from "effect"
import { adjust as adjustClock } from "effect/testing/TestClock"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionInput } from "@miao/core/session/input"
import { SessionDelegationStore } from "@miao/core/session/delegation-store"
import { SessionNotificationTable } from "@miao/core/session/sql"
import { eq } from "drizzle-orm"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionSchedule } from "@miao/core/session/schedule"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionTable } from "@miao/core/session/sql"
import { testEffect } from "./lib/effect"

/**
 * Records the wake the scheduler issues, so the test waits on a signal instead
 * of sleeping. Set before creating a job.
 */
let woken: Deferred.Deferred<SessionSchema.ID> | undefined

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<SessionSchema.ID>()),
    executions: Effect.succeed(new Map<SessionSchema.ID, string>()),
    status: () => Effect.succeed({ type: "idle" }),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    interruptIf: () => Effect.succeed(false),
    wait: () => Effect.void,
    wake: (sessionID) =>
      (woken === undefined ? Effect.void : Deferred.succeed(woken, sessionID).pipe(Effect.asVoid)) as Effect.Effect<void>,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionSchedule.node, Database.node, EventV2.node, SessionProjector.node]), [
    [SessionExecution.node, execution],
  ]),
)

/** A session row, so the `session_input` foreign key holds. */
const insertSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectID = Project.ID.make("prj_schedule_test")
    const directory = AbsolutePath.make("/tmp/miao-schedule")
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "schedule",
        directory,
        title: "schedule",
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("SessionSchedule", () => {
  it.live("admits a queued machine notice and wakes the Session without creating a human prompt", () =>
    Effect.gen(function* () {
      const schedule = yield* SessionSchedule.Service
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_schedule_fire")
      yield* insertSession(sessionID)
      woken = yield* Deferred.make<SessionSchema.ID>()

      const info = yield* schedule.create({ sessionID, prompt: "wake up", delaySeconds: 0.05 })
      expect(info.recurring).toBe(false)

      const observed = yield* Deferred.await(woken).pipe(Effect.timeoutOption(Duration.seconds(10)))
      expect(Option.isSome(observed)).toBe(true)
      expect(Option.getOrThrow(observed)).toBe(sessionID)

      expect((yield* SessionInput.pending(db, { sessionID, limit: 10 })).inputs).toHaveLength(0)
      const pending = yield* SessionDelegationStore.pendingSchedule(db, sessionID, info.id)
      expect(pending).toBeDefined()
      const row = yield* db.select().from(SessionNotificationTable).where(eq(SessionNotificationTable.id, pending!.id)).get().pipe(Effect.orDie)
      expect(row?.text).toBe("wake up")
      expect(row?.metadata).toEqual({ scheduleID: info.id, scheduled: true, delivery: "queue" })

      // A one-shot job removes itself once it has fired.
      expect(yield* schedule.list(sessionID)).toHaveLength(0)
    }),
  )

  it.effect("coalesces repeated ticks until consumed and admits a fresh notice after promotion", () =>
    Effect.gen(function* () {
      const schedule = yield* SessionSchedule.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_schedule_coalesce")
      yield* insertSession(sessionID)
      woken = undefined
      const job = yield* schedule.create({ sessionID, prompt: "continue once", cron: "* * * * *", recurring: true })
      yield* Effect.yieldNow
      yield* adjustClock(Duration.minutes(1))
      yield* Effect.yieldNow
      const first = yield* SessionDelegationStore.pendingSchedule(db, sessionID, job.id)
      expect(first).toBeDefined()
      yield* adjustClock(Duration.minutes(1))
      yield* Effect.yieldNow
      expect(yield* SessionDelegationStore.pendingCount(db, sessionID)).toBe(1)
      expect((yield* SessionDelegationStore.pendingSchedule(db, sessionID, job.id))?.id).toBe(first?.id)
      expect(yield* SessionDelegationStore.hasPromotableNotifications(db, sessionID, false)).toBe(false)
      expect(yield* SessionDelegationStore.promoteNext(db, events, sessionID, false)).toBe(false)
      expect(yield* SessionDelegationStore.promoteNext(db, events, sessionID)).toBe(true)
      expect(yield* SessionDelegationStore.wakeAllowance(db, sessionID)).toBe(SessionDelegationStore.WAKE_BUDGET - 1)
      yield* adjustClock(Duration.minutes(1))
      yield* Effect.yieldNow
      const next = yield* SessionDelegationStore.pendingSchedule(db, sessionID, job.id)
      expect(next).toBeDefined()
      expect(next?.id).not.toBe(first?.id)
      expect(yield* SessionDelegationStore.pendingCount(db, sessionID)).toBe(1)
      expect((yield* SessionInput.pending(db, { sessionID, limit: 10 })).inputs).toHaveLength(0)
      expect(yield* SessionDelegationStore.wakeAllowance(db, sessionID)).toBe(SessionDelegationStore.WAKE_BUDGET - 1)
      yield* schedule.remove(job.id)
    }),
  )

  it.live("lists and removes jobs by id", () =>
    Effect.gen(function* () {
      const schedule = yield* SessionSchedule.Service
      const sessionID = SessionV2.ID.make("ses_schedule_list")
      yield* insertSession(sessionID)

      const info = yield* schedule.create({ sessionID, prompt: "later", cron: "0 0 1 1 *", recurring: true })
      expect(info.expression).toBe("0 0 1 1 *")
      expect(yield* schedule.count()).toBe(1)

      const jobs = yield* schedule.list(sessionID)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.id).toBe(info.id)
      expect(jobs[0]!.nextAt).toBe(info.nextAt)

      expect(yield* schedule.remove(info.id)).toBe(true)
      expect(yield* schedule.list(sessionID)).toHaveLength(0)
      expect(yield* schedule.remove(info.id)).toBe(false)
    }),
  )

  it.live("rejects an unparseable cron expression with a typed error", () =>
    Effect.gen(function* () {
      const schedule = yield* SessionSchedule.Service
      const sessionID = SessionV2.ID.make("ses_schedule_invalid")
      yield* insertSession(sessionID)

      const error = yield* schedule.create({ sessionID, prompt: "no", cron: "not cron" }).pipe(Effect.flip)
      expect(error._tag).toBe("SessionSchedule.Invalid")
      expect(yield* schedule.count()).toBe(0)
    }),
  )
})
