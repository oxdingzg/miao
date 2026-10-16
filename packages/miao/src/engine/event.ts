import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { Location } from "@miao/schema/location"
import { Effect, Schema } from "effect"
import type { EngineSessionEvent } from "./session"

/** The bridge produces Type-side events (DateTime instances, branded ids), so
 * membership is checked against the union's Type schema, not its encoded form —
 * validating the encoded side rejected every settlement and killed delivery. */
const validEvent = Schema.is(OpenCodeEvent)

export class SourceMismatchError extends Schema.TaggedErrorClass<SourceMismatchError>()("EngineEvent.SourceMismatch", {
  sessionID: Schema.String,
}) {}

export class InvalidEventError extends Schema.TaggedErrorClass<InvalidEventError>()("EngineEvent.Invalid", {
  type: Schema.String,
}) {}

/**
 * Give a bridged product payload its replay-stable delivery id. Rust's cursor
 * is provenance, not a TS durable journal sequence. The engine identity must
 * identify the authoritative store, not this client connection.
 */
export const clientEvent = Effect.fn("Engine.clientEvent")(function* (
  event: EngineSessionEvent,
  input: { engineID: string; location: Location.Ref },
) {
  const key = JSON.stringify([input.engineID, event.source.sessionID, event.source.seq, event.type, event.source.index])
  const id = `evt_engine_${new Bun.CryptoHasher("sha256").update(key).digest("hex")}`
  const wire = {
    id,
    type: event.type,
    data: event.data,
    location: input.location,
    metadata: {
      engine: {
        id: input.engineID,
        session_id: event.source.sessionID,
        seq: event.source.seq,
        index: event.source.index,
        recorded_at_ms: event.source.recordedAtMs ?? null,
      },
    },
  }
  if (!validEvent(wire)) return yield* Effect.fail(new InvalidEventError({ type: event.type }))
  const sessionID = (event.data as { sessionID?: string }).sessionID
  if (sessionID !== event.source.sessionID) {
    return yield* Effect.fail(new SourceMismatchError({ sessionID: event.source.sessionID }))
  }
  return wire
})
