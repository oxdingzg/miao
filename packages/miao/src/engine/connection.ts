import { ClientEvents } from "@miao/server/client-events"
import { Location } from "@miao/schema/location"
import { DateTime, Deferred, Effect, Fiber, Queue } from "effect"
import { Event } from "@miao/schema/event"
import { SessionID } from "@miao/schema/session-id"
import { EngineClient, type EngineOptions } from "./client"
import { clientEvent } from "./event"
import { EngineSession, type CredentialExpiredTrigger, type EnginePricing, type EngineSessionEvent } from "./session"

/** Scoped native owner with ordered delivery into the actual client fan-out. */
export const connectEngine = Effect.fn("Engine.connect")(function* (
  options: EngineOptions & { engineID: string; location: Location.Ref },
  pricing?: EnginePricing,
  onCredentialExpired?: CredentialExpiredTrigger,
) {
  const clients = yield* ClientEvents.Service
  const pending = yield* Queue.unbounded<
    EngineSessionEvent | { barrier: Deferred.Deferred<void> } | { failure: Error }
  >()
  const client = EngineClient.start(options)
  const session = new EngineSession(
    client,
    (event) => {
      Queue.offerUnsafe(pending, event)
    },
    pricing,
    onCredentialExpired,
  )
  client.onFailure((failure) => Queue.offerUnsafe(pending, { failure }))
  const delivery = yield* Effect.gen(function* () {
    const busy = new Set<SessionID>()
    while (true) {
      const next = yield* Queue.take(pending)
      if ("barrier" in next) {
        yield* Deferred.succeed(next.barrier, undefined)
        continue
      }
      if ("failure" in next) {
        // Transport loss has no durable engine cursor. Publish a live failure
        // in queue order; never invent a committed run end or retry tools.
        for (const sessionID of busy) {
          const timestamp = DateTime.makeUnsafe(Date.now())
          yield* clients.publish({
            id: Event.ID.create(),
            type: "session.next.failed",
            location: options.location,
            data: {
              sessionID,
              timestamp,
              name: "EngineConnectionFailed",
              error: { type: "unknown", message: next.failure.message },
            },
          })
          yield* clients.publish({
            id: Event.ID.create(),
            type: "session.next.status",
            location: options.location,
            data: { sessionID, timestamp, status: { type: "idle" } },
          })
        }
        busy.clear()
        continue
      }
      const event = yield* clientEvent(next, options)
      if (event.type === "session.next.status") {
        if (event.data.status.type === "idle") busy.delete(event.data.sessionID)
        else busy.add(event.data.sessionID)
      }
      yield* clients.publish(event)
    }
  }).pipe(Effect.forkScoped)
  // Drain received bridge events only; subscription acceptance is not a native
  // replay high-watermark and does not guarantee that polling has caught up.
  const flush = Effect.gen(function* () {
    const barrier = yield* Deferred.make<void>()
    yield* Queue.offer(pending, { barrier })
    // A schema/publication failure must surface instead of leaving a barrier
    // waiting forever behind a stopped delivery worker.
    yield* Deferred.await(barrier).pipe(Effect.raceFirst(Fiber.join(delivery)))
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => client.close()).pipe(
      Effect.andThen(flush),
      Effect.onExit(() => Queue.shutdown(pending)),
      Effect.catchCause((cause) => Effect.logError("Native client delivery failed", cause)),
    ),
  )
  return { client, session, flush }
})
