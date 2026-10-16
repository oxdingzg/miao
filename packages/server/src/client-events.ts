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

/**
 * The subscriber registry is process-scoped on purpose. Several graphs build
 * this service: the HTTP assembly that streams `/api/event`, the event
 * forwarder, and a fresh native transport layer per listener. A registry that
 * each build owned privately meant the native bridge published product events
 * into an instance with no subscribers, so an attached client never saw a
 * native Session's stream or its pending approvals. Subscriptions remove
 * themselves through their own finalizers, so sharing one set here does not
 * outlive a graph.
 */
const subscribers = new Set<Subscriber>()

/** Client fan-out only: no TS journal, projector, or replay owner is involved. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
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
