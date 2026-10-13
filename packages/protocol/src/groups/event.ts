import { Event } from "@miao/schema/event"
import { EventManifest } from "@miao/schema/event-manifest"
import { Location } from "@miao/schema/location"
import type { Definition } from "@miao/schema/event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const fields = {
  id: Event.ID,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  durable: Schema.optional(Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int })),
  location: Schema.optional(Location.Ref),
}

const schema = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  Schema.Union([
    ...definitions,
    ...(definitions.some((definition) => definition.type === "server.connected")
      ? []
      : [
          Schema.Struct({
            ...fields,
            type: Schema.Literal("server.connected"),
            data: Schema.Struct({}),
          }).annotate({ identifier: "V2Event.server.connected" }),
        ]),
  ]).annotate({ identifier: "V2Event" })

const make = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) => {
  const EventSchema = schema(definitions)
  const DurableQuery = Schema.Struct({
    aggregateID: Schema.String.annotate({
      description: "Aggregate (session) whose durable event log to replay.",
    }),
    after: Schema.optional(
      Schema.Int.annotate({
        description: "Exclusive durable sequence cursor; omit to replay from the beginning.",
      }),
    ),
  }).annotate({ identifier: "EventDurableQuery" })
  return {
    schema: EventSchema,
    group: HttpApiGroup.make("server.event")
      .add(
        HttpApiEndpoint.get("event.subscribe", "/api/event", {
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.event.subscribe",
            summary: "Subscribe to events",
            description: "Subscribe to native event payloads for the server.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("event.durable", "/api/event/durable", {
          query: DurableQuery,
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.event.durable",
            summary: "Replay durable events",
            description:
              "Replay one aggregate's durable event log from a sequence cursor, then keep following it as new events commit. Every frame carries its durable aggregateID, seq, and version, so a consumer resumes by passing the last seen seq back as after.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "events", description: "Experimental event stream route." })),
  }
}

export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  make(definitions).group

const event = make(EventManifest.ServerDefinitions)
export const EventGroup = event.group
export const OpenCodeEvent = event.schema
export type OpenCodeEvent = typeof OpenCodeEvent.Type
export type OpenCodeEventEncoded = typeof OpenCodeEvent.Encoded
