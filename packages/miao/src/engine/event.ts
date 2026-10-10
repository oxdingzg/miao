import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { Location } from "@miao/schema/location"
import { Effect, Schema } from "effect"
import type { EngineSessionEvent } from "./session"

const validate = Schema.decodeUnknownEffect(Schema.toType(OpenCodeEvent))

export class SourceMismatchError extends Schema.TaggedErrorClass<SourceMismatchError>()("EngineEvent.SourceMismatch", {
  sessionID: Schema.String,
}) {}

/**
 * Validate a bridged product payload and give it a replay-stable delivery id.
 * Rust's cursor is provenance, not a TS durable journal sequence. The engine
 * identity must identify the authoritative store, not this client connection.
 */
export const clientEvent = Effect.fn("Engine.clientEvent")(function* (
  event: EngineSessionEvent,
  input: { engineID: string; location: Location.Ref },
) {
  const key = JSON.stringify([input.engineID, event.source.sessionID, event.source.seq, event.type, event.source.index])
  const id = `evt_engine_${new Bun.CryptoHasher("sha256").update(key).digest("hex")}`
  const decoded = yield* validate({
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
  })
  if (!("sessionID" in decoded.data) || decoded.data.sessionID !== event.source.sessionID) {
    return yield* Effect.fail(new SourceMismatchError({ sessionID: event.source.sessionID }))
  }
  return decoded
})
