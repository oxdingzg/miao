import { Cause, DateTime, Effect, Layer } from "effect"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionEvent } from "../event"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { Database } from "../../database/database"
import { SessionDelegation } from "../delegation"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    // Declared before the coordinator so the drain closure can wake peer Sessions
    // without a circular type reference.
    let wake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    let delegation: SessionDelegation.API | undefined
    // A high default bounds runaway fan-out without constraining normal use.
    // `MIAO_MAX_CONCURRENT_DRAINS=0` (or a non-positive value) removes the cap.
    const configured = Number(process.env.MIAO_MAX_CONCURRENT_DRAINS ?? 8)
    const maxConcurrent = Number.isFinite(configured) && configured > 0 ? configured : undefined
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      maxConcurrent,
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force, wake, delegation })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
      status: Effect.fnUntraced(
        function* (sessionID: SessionSchema.ID, status: "busy" | "idle") {
          const session = yield* store.get(sessionID)
          yield* events.publish(
            SessionEvent.Status,
            { sessionID, timestamp: yield* DateTime.now, status: { type: status } },
            session ? { location: session.location } : undefined,
          )
        },
        Effect.catchDefect((defect) => Effect.logWarning("failed to publish session status", { defect })),
      ),
    })
    wake = coordinator.wake
    const backgroundLimit = Number(process.env.MIAO_MAX_BACKGROUND_SUBAGENTS ?? 4)
    delegation = yield* SessionDelegation.make({
      db,
      events,
      store,
      wake: coordinator.wake,
      wait: coordinator.awaitIdle,
      executions: coordinator.executions,
      interruptIf: coordinator.interruptIf,
      maximum: Number.isFinite(backgroundLimit) && backgroundLimit > 0 ? Math.max(1, Math.floor(backgroundLimit)) : 4,
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      executions: coordinator.executions,
      interrupt: coordinator.interrupt,
      interruptIf: coordinator.interruptIf,
      resume: coordinator.run,
      wake: coordinator.wake,
      wait: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node, Database.node],
})

export * as SessionExecutionLocal from "./local"
