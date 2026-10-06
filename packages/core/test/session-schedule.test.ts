import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Layer, Option } from "effect"
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
  it.live("admits a queued prompt and wakes the Session when a job fires", () =>
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

      const pending = yield* SessionInput.pending(db, { sessionID, limit: 10 })
      expect(pending.inputs).toHaveLength(1)
      expect(pending.inputs[0].delivery).toBe("queue")
      expect(pending.inputs[0].prompt.text).toBe("wake up")

      // A one-shot job removes itself once it has fired.
      expect(yield* schedule.list(sessionID)).toHaveLength(0)
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
