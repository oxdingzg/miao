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
import { SessionOwnership } from "../ownership"
import { SessionDelegation } from "../delegation"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const ownership = yield* SessionOwnership.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    // Declared before the coordinator so the drain closure can wake peer Sessions
    // without a circular type reference.
    let wake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    let delegation: SessionDelegation.API | undefined
    // Same forward-reference break as `wake`: the runner reports phases into the
    // coordinator that owns the drain.
    let setPhase: (sessionID: SessionSchema.ID, phase: SessionEvent.BusyPhase) => Effect.Effect<void> = () =>
      Effect.void
    // A high default bounds runaway fan-out without constraining normal use.
    // `MIAO_MAX_CONCURRENT_DRAINS=0` (or a non-positive value) removes the cap.
    const configured = Number(process.env.MIAO_MAX_CONCURRENT_DRAINS ?? 8)
    const maxConcurrent = Number.isFinite(configured) && configured > 0 ? configured : undefined
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      maxConcurrent,
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) =>
          runner.run({
            sessionID,
            force,
            wake,
            delegation,
            phase: (phase) => setPhase(sessionID, phase),
          }),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? // Interrupts are a normal control path (esc, undo, shutdown), but a
                // silent drain exit makes them impossible to attribute after the
                // fact, so record that the signal arrived.
                Effect.logWarning("Session drain was interrupted", { sessionID })
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
      report: Effect.fnUntraced(
        function* (sessionID: SessionSchema.ID, status: SessionRunCoordinator.Status) {
          const session = yield* store.get(sessionID)
          yield* events.publish(
            SessionEvent.Status,
            {
              sessionID,
              timestamp: yield* DateTime.now,
              status:
                status.type === "busy"
                  ? { type: "busy" as const, phase: status.phase, since: status.since }
                  : { type: "idle" as const },
            },
            session ? { location: session.location } : undefined,
          )
        },
        Effect.catchDefect((defect) => Effect.logWarning("failed to publish session status", { defect })),
      ),
    })
    // A wake is advisory and process-local. A Session owned by another window
    // keeps its durable input for that window to drain, so a failed claim is not
    // a conflict here; claiming would also pin the target's lease to this runtime,
    // which the send_message admission deliberately avoids.
    wake = (sessionID) =>
      ownership.claim(sessionID).pipe(
        Effect.as(true),
        Effect.catchDefect((defect) =>
          defect instanceof SessionOwnership.BusyError
            ? Effect.logDebug("Session is owned by another window; leaving the wakeup durable", { sessionID }).pipe(
                Effect.as(false),
              )
            : Effect.die(defect),
        ),
        Effect.flatMap((claimed) => (claimed ? coordinator.wake(sessionID) : Effect.void)),
      )
    setPhase = coordinator.setPhase
    const backgroundLimit = Number(process.env.MIAO_MAX_BACKGROUND_SUBAGENTS ?? 4)
    delegation = yield* SessionDelegation.make({
      db,
      events,
      store,
      wake,
      wait: coordinator.awaitIdle,
      executions: coordinator.executions,
      interruptIf: coordinator.interruptIf,
      maximum: Number.isFinite(backgroundLimit) && backgroundLimit > 0 ? Math.max(1, Math.floor(backgroundLimit)) : 4,
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      executions: coordinator.executions,
      status: coordinator.status,
      interrupt: coordinator.interrupt,
      interruptIf: coordinator.interruptIf,
      resume: (sessionID) => ownership.claim(sessionID).pipe(Effect.andThen(coordinator.run(sessionID))),
      wake,
      wait: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node, Database.node, SessionOwnership.node],
})

export * as SessionExecutionLocal from "./local"
