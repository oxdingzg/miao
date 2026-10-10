export * as ClientEvents from "./client-events"

import { makeGlobalNode } from "@miao/core/effect/app-node"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "ClientEvents.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export class DurableEnvelopeError extends Schema.TaggedErrorClass<DurableEnvelopeError>()(
  "ClientEvents.DurableEnvelope",
  { type: Schema.String },
) {}

type Subscriber = (event: OpenCodeEvent) => Effect.Effect<void>

export interface Interface {
  publish(event: OpenCodeEvent): Effect.Effect<void, DurableEnvelopeError>
  listen(subscriber: Subscriber): Effect.Effect<Effect.Effect<void>>
  allBounded(capacity: number): Effect.Effect<Stream.Stream<OpenCodeEvent, SubscriberOverflowError>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ClientEvents") {}

/** Client fan-out only: no TS journal, projector, or replay owner is involved. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const subscribers = new Set<Subscriber>()
    yield* Effect.addFinalizer(() => Effect.sync(() => subscribers.clear()))
    const listen = (subscriber: Subscriber) =>
      Effect.sync(() => {
        subscribers.add(subscriber)
        return Effect.sync(() => {
          subscribers.delete(subscriber)
        })
      })
    return Service.of({
      publish: Effect.fn("ClientEvents.publish")(function* (event) {
        // Rust cursors must not masquerade as the TS journal's durable sequence.
        if (event.durable !== undefined) return yield* Effect.fail(new DurableEnvelopeError({ type: event.type }))
        return yield* Effect.forEach(
          Array.from(subscribers),
          (subscriber) =>
            subscriber(event).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                (cause) => Effect.logError("Client event subscriber failed", cause),
              ),
            ),
          { discard: true },
        )
      }),
      listen,
      allBounded: Effect.fn("ClientEvents.allBounded")(function* (capacity) {
        const queue = yield* Queue.dropping<OpenCodeEvent, SubscriberOverflowError>(capacity)
        const unsubscribe = yield* listen((event) =>
          Queue.offer(queue, event).pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.void : Queue.fail(queue, new SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
            ),
          ),
        )
        yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
        return Stream.fromQueue(queue)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
