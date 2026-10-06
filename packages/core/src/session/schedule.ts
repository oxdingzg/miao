export * as SessionSchedule from "./schedule"

import { Clock, Context, Duration, Effect, Exit, Layer, Schema, Scope, SynchronizedRef } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Identifier } from "../id/id"
import { Cron } from "./cron"
import { SessionOwnership } from "./ownership"
import { SessionExecution } from "./execution"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"

/** Recurring jobs stop on their own after this long, so one cannot run forever by accident. */
export const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("SessionSchedule.Invalid", {
  message: Schema.String,
}) {}

export type CreateInput = {
  readonly sessionID: SessionSchema.ID
  readonly prompt: string
  readonly cron?: string
  readonly delaySeconds?: number
  readonly recurring?: boolean
}

export type Info = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly prompt: string
  /** Set when the job fires on a cron expression; absent for delay jobs. */
  readonly expression?: string
  /** Set when the job fires once after a delay; absent for cron jobs. */
  readonly delaySeconds?: number
  readonly recurring: boolean
  readonly createdAt: number
  readonly nextAt: number
}

type Job = {
  readonly info: Info
  readonly scope: Scope.Closeable
  readonly token: object
}

type State = {
  readonly jobs: SynchronizedRef.SynchronizedRef<Map<string, Job>>
  readonly scope: Scope.Scope
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, Invalid>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly count: () => Effect.Effect<number>
  readonly remove: (id: string) => Effect.Effect<boolean>
}

/**
 * Process-local scheduling of prompts into their own Session.
 *
 * Jobs are deliberately not durable: they live only for the lifetime of this
 * process and are lost on restart. A restarted process must not fire a prompt
 * nobody asked for, and post-crash continuation recovery needs its own explicit
 * design before it may retry provider work, so a durable schedule is out of
 * scope here.
 */
export class Service extends Context.Service<Service, Interface>()("@miao/SessionSchedule") {}

export const make = Effect.gen(function* () {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }
  // Capture the collaborators once so the public methods require nothing.
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const ownership = yield* SessionOwnership.Service

  // Firing reuses the sanctioned prompt admission path: one durable
  // `session_input` row, then an advisory wake. `queue` delivery makes the
  // scheduled text wait until the Session is otherwise idle, like a human
  // queued message. It must never call the runner directly.
  const fire = Effect.fn("SessionSchedule.fire")(function* (info: Info) {
    const admitted = yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.create(),
      sessionID: info.sessionID,
      prompt: Prompt.make({ text: info.prompt }),
      delivery: "queue",
    })
    yield* execution.wake(admitted.sessionID)
  })

  const detach = (id: string, token?: object) =>
    SynchronizedRef.modify(state.jobs, (jobs): readonly [Job | undefined, Map<string, Job>] => {
      const job = jobs.get(id)
      if (!job || (token !== undefined && job.token !== token)) return [undefined, jobs]
      const next = new Map(jobs)
      next.delete(id)
      return [job, next]
    })

  // The job's own fiber must not close the scope it runs in, so the close is
  // forked onto the service scope instead.
  const finish = Effect.fn("SessionSchedule.finish")(function* (id: string, token: object) {
    const job = yield* detach(id, token)
    if (!job) return
    yield* Scope.close(job.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
  })

  const run = Effect.fnUntraced(function* (id: string, token: object) {
    while (true) {
      const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
      if (!job || job.token !== token) return
      const now = yield* Clock.currentTimeMillis
      if (job.info.nextAt > now) yield* Effect.sleep(Duration.millis(job.info.nextAt - now))
      if (!job.info.recurring || job.info.expression === undefined) {
        // Detach before firing so a finished one-shot job never lingers in the
        // listing, even while its admission is still running.
        const detached = yield* detach(id, token)
        if (!detached) return
        yield* fire(detached.info)
        yield* Scope.close(detached.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
        return
      }
      yield* fire(job.info)
      const nextAt = Cron.next(job.info.expression, yield* Clock.currentTimeMillis)
      if (nextAt === undefined || nextAt > job.info.createdAt + RECURRING_LIFETIME_MS) return yield* finish(id, token)
      yield* SynchronizedRef.update(state.jobs, (jobs) => {
        const current = jobs.get(id)
        if (!current || current.token !== token) return jobs
        return new Map(jobs).set(id, { ...current, info: { ...current.info, nextAt } })
      })
    }
  })

  const create: Interface["create"] = Effect.fn("SessionSchedule.create")(function* (input) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* ownership.claim(input.sessionID)
        const createdAt = yield* Clock.currentTimeMillis
        const nextAt = yield* Effect.gen(function* () {
          if (input.cron !== undefined) {
            const parsed = Cron.parse(input.cron)
            if (parsed instanceof Cron.ParseError) return yield* new Invalid({ message: parsed.message })
            const first = Cron.next(parsed, createdAt)
            if (first === undefined)
              return yield* new Invalid({
                message: `Cron expression "${input.cron}" has no fire time within four years.`,
              })
            return first
          }
          if (input.delaySeconds === undefined || !(input.delaySeconds > 0))
            return yield* new Invalid({ message: "A schedule needs either a cron expression or a positive delay." })
          return createdAt + input.delaySeconds * 1000
        })
        const id = Identifier.create("sched", "ascending")
        const token = {}
        const info: Info = {
          id,
          sessionID: input.sessionID,
          prompt: input.prompt,
          ...(input.cron === undefined ? {} : { expression: input.cron }),
          ...(input.delaySeconds === undefined ? {} : { delaySeconds: input.delaySeconds }),
          recurring: input.recurring ?? false,
          createdAt,
          nextAt,
        }
        const scope = yield* Scope.fork(state.scope, "parallel")
        yield* SynchronizedRef.update(state.jobs, (jobs) => new Map(jobs).set(id, { info, scope, token }))
        yield* run(id, token).pipe(Effect.forkIn(scope, { startImmediately: true }))
        return info
      }),
    )
  })

  const list: Interface["list"] = Effect.fn("SessionSchedule.list")(function* (sessionID) {
    return [...(yield* SynchronizedRef.get(state.jobs)).values()]
      .map((job) => job.info)
      .filter((info) => info.sessionID === sessionID)
      .toSorted((a, b) => a.nextAt - b.nextAt)
  })

  const count: Interface["count"] = Effect.fn("SessionSchedule.count")(function* () {
    return (yield* SynchronizedRef.get(state.jobs)).size
  })

  const remove: Interface["remove"] = Effect.fn("SessionSchedule.remove")(function* (id) {
    const job = yield* detach(id)
    if (!job) return false
    yield* Scope.close(job.scope, Exit.void)
    return true
  })

  return Service.of({ create, list, count, remove })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionExecution.node, SessionOwnership.node],
})
