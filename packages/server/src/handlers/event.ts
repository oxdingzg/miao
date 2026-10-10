import { EventV2 } from "@miao/core/event"
import { OpenCodeEvent, type OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { ClientEvents } from "../client-events"

const subscriberCapacity = 256

// Every EventV2 event reaches this stream, including types the public protocol does not
// declare (V1 bridge events such as `vcs.branch.updated`). Those are skipped: a failed encode
// would otherwise end the whole subscription.
const encodeEvent = Schema.encodeUnknownOption(OpenCodeEvent)

function eventData(data: OpenCodeEventEncoded): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const clients = yield* ClientEvents.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            const external = yield* clients.allBounded(subscriberCapacity)
            return Stream.make(connected).pipe(
              Stream.concat(live.pipe(Stream.merge(external, { haltStrategy: "either" }))),
            )
          }),
        ).pipe(
          Stream.map((event) => encodeEvent(event)),
          Stream.filter(Option.isSome),
          Stream.map((event) => eventData(event.value)),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
