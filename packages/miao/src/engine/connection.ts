import { ClientEvents } from "@miao/server/client-events"
import { Location } from "@miao/schema/location"
import { Deferred, Effect, Fiber, Queue } from "effect"
import { EngineClient, type EngineOptions } from "./client"
import { clientEvent } from "./event"
import { EngineSession, type EnginePricing, type EngineSessionEvent } from "./session"

/** Scoped native owner with ordered delivery into the actual client fan-out. */
export const connectEngine = Effect.fn("Engine.connect")(function* (
  options: EngineOptions & { engineID: string; location: Location.Ref },
  pricing?: EnginePricing,
) {
  const clients = yield* ClientEvents.Service
  const pending = yield* Queue.unbounded<EngineSessionEvent | { barrier: Deferred.Deferred<void> }>()
  const client = EngineClient.start(options)
  const session = new EngineSession(client, (event) => {
    Queue.offerUnsafe(pending, event)
  }, pricing)
  const delivery = yield* Effect.gen(function* () {
    while (true) {
      const next = yield* Queue.take(pending)
      if ("barrier" in next) {
        yield* Deferred.succeed(next.barrier, undefined)
        continue
      }
      const event = yield* clientEvent(next, options)
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
