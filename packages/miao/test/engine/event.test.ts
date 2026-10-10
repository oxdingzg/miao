import { expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { Location } from "@miao/schema/location"
import { clientEvent } from "@/engine/event"
import { translateMessage } from "@/engine/bridge"
import { it } from "../lib/effect"

const location = Schema.decodeUnknownSync(Location.Ref)({ directory: "/tmp/engine-envelope" })
const text = translateMessage({
  session_id: "ses_envelope",
  seq: 42,
  kind: "message.committed",
  data: { role: "assistant", content: [{ type: "text", text: "persisted" }] },
})[0]
const output = {
  type: "session.next.text.ended",
  data: text,
  source: { sessionID: "ses_envelope", seq: 42, index: 0 },
}

it.effect("validates decoded bridge payloads and keeps the Rust cursor out of TS durable fields", () =>
  Effect.gen(function* () {
    const event = yield* clientEvent(output, { engineID: "store-a", location })
    expect(event.durable).toBeUndefined()
    expect(event.metadata).toEqual({
      engine: { id: "store-a", session_id: "ses_envelope", seq: 42, index: 0, recorded_at_ms: null },
    })
    const wire = yield* Schema.encodeEffect(OpenCodeEvent)(event)
    expect(JSON.stringify(wire)).toContain('"text":"persisted"')
    expect(JSON.stringify(wire)).toContain(`"timestamp":${DateTime.toEpochMillis(text.timestamp)}`)
  }),
)

it.effect("delivery ids are stable on replay and distinct across stores, Sessions, and message parts", () =>
  Effect.gen(function* () {
    const first = yield* clientEvent(output, { engineID: "store-a", location })
    const retry = yield* clientEvent(output, { engineID: "store-a", location })
    const store = yield* clientEvent(output, { engineID: "store-b", location })
    const part = yield* clientEvent(
      { ...output, source: { ...output.source, index: 1 } },
      { engineID: "store-a", location },
    )
    const other = translateMessage({
      session_id: "ses_other",
      seq: 42,
      kind: "message.committed",
      data: { role: "assistant", content: [{ type: "text", text: "persisted" }] },
    })[0]
    const session = yield* clientEvent(
      { ...output, data: other, source: { ...output.source, sessionID: "ses_other" } },
      { engineID: "store-a", location },
    )
    expect(first.id).toBe(retry.id)
    expect(new Set([first.id, store.id, part.id, session.id]).size).toBe(4)
  }),
)

it.effect("rejects invalid or unregistered product event payloads before client fan-out", () =>
  Effect.gen(function* () {
    const invalid = yield* clientEvent(
      { ...output, data: { text: "missing required fields" } },
      { engineID: "store-a", location },
    ).pipe(Effect.exit)
    expect(Exit.isFailure(invalid)).toBe(true)
    const unknown = yield* clientEvent({ ...output, type: "engine.unknown" }, { engineID: "store-a", location }).pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(unknown)).toBe(true)
    const crossSession = yield* clientEvent(
      { ...output, source: { ...output.source, sessionID: "ses_other" } },
      { engineID: "store-a", location },
    ).pipe(Effect.exit)
    expect(Exit.isFailure(crossSession)).toBe(true)
  }),
)
