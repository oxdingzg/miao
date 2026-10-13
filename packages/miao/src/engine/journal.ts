import { Effect, Option, Schema } from "effect"
import { SessionEvent } from "@miao/schema/session-event"
import { Location } from "@miao/schema/location"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { EngineError } from "./client"
import { clientEvent } from "./event"
import { EngineTranslator, isReplayEvent, type EngineSessionEvent } from "./session"

/** Rebuild bridge state from the prefix, emitting only events beyond the requested cursor. */
export async function replayJournal(input: {
  sessionID: string
  after: number
  limit?: number
  engineID: string
  location: Location.Ref
  request: (method: string, params: { session_id: string; after?: number }) => Promise<unknown>
}) {
  const snapshot = await input.request("snapshot", { session_id: input.sessionID })
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !("session_id" in snapshot) ||
    snapshot.session_id !== input.sessionID ||
    !("cursor" in snapshot) ||
    typeof snapshot.cursor !== "number" ||
    !Number.isSafeInteger(snapshot.cursor) ||
    snapshot.cursor < 0
  )
    throw new EngineError("engine_replay_invalid", "native snapshot has no valid cursor")
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator((event) => {
    if (event.source.seq > input.after) outputs.push(event)
  })
  let after = 0
  while (after < snapshot.cursor) {
    const page = await input.request("events", { session_id: input.sessionID, after })
    if (!Array.isArray(page) || page.length === 0)
      throw new EngineError("engine_replay_invalid", "native journal ended before the snapshot cursor")
    for (const raw of page) {
      if (!isReplayEvent(raw, input.sessionID) || raw.seq !== after + 1)
        throw new EngineError("engine_replay_invalid", "native journal is invalid or discontinuous")
      if (raw.seq > snapshot.cursor) break
      translator.dispatch(raw)
      after = raw.seq
    }
  }
  const events: OpenCodeEvent[] = []
  for (const output of outputs) {
    events.push(await Effect.runPromise(clientEvent(output, input)))
  }
  if (input.limit === undefined) return { events, cursor: Math.max(input.after, snapshot.cursor), hasMore: false }
  const decode = Schema.decodeUnknownOption(Schema.toType(SessionEvent.Durable))
  const durable = events
    .map((event) => decode(event))
    .filter(Option.isSome)
    .map((event) => event.value)
  // An exclusive native cursor cannot address individual projections of one
  // journal row. Keep that whole sequence group together, even beyond limit.
  const boundary = durable[Math.max(1, input.limit) - 1]?.metadata?.engine
  const sequence =
    typeof boundary === "object" && boundary !== null && "seq" in boundary && typeof boundary.seq === "number"
      ? boundary.seq
      : undefined
  const selected =
    sequence === undefined
      ? durable
      : durable.filter((event) => {
          const engine = event.metadata?.engine
          return (
            typeof engine === "object" &&
            engine !== null &&
            "seq" in engine &&
            typeof engine.seq === "number" &&
            engine.seq <= sequence
          )
        })
  return {
    events: selected,
    cursor: sequence ?? Math.max(input.after, snapshot.cursor),
    hasMore: selected.length < durable.length,
  }
}
