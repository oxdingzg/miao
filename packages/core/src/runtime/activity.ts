export * as RuntimeActivity from "./activity"

import { Context, Effect, Layer } from "effect"
import { BackgroundJob } from "../background-job"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { SessionInput } from "../session/input"
import { SessionSchedule } from "../session/schedule"

/**
 * The core-owned part of the Runtime's activity vector
 * (`specs/runtime-lifetime.md`). Connected clients and remote-control state are
 * transport-owned and are added by the Runtime host.
 */
export type Snapshot = {
  /** Active drains, including one whose cleanup (stopping) is still in flight. */
  readonly executions: number
  readonly unpromoted: number
  readonly scheduled: number
  readonly background: number
}

export interface Interface {
  readonly snapshot: Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@miao/RuntimeActivity") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const execution = yield* SessionExecution.Service
    const schedule = yield* SessionSchedule.Service
    const jobs = yield* BackgroundJob.Service
    const db = (yield* Database.Service).db
    return Service.of({
      snapshot: Effect.gen(function* () {
        const active = yield* execution.executions
        const jobs_ = yield* jobs.list()
        return {
          executions: active.size,
          unpromoted: yield* SessionInput.countAllPending(db),
          scheduled: yield* schedule.count(),
          background: jobs_.filter((job) => job.status === "running").length,
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecution.node, SessionSchedule.node, BackgroundJob.node, Database.node],
})
