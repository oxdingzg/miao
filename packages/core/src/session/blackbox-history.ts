export * as BlackboxHistory from "./blackbox-history"

import { Effect, Schema } from "effect"
import { SessionMessage } from "@miao/schema/session-message"
import { BlackboxTape } from "../blackbox/tape"
import { SessionBlackbox } from "./blackbox"
import { SessionInput } from "./input"
import { SessionSchema } from "./schema"
import type { Database } from "../database/database"

/** Generated product IDs and observation times are correlated by message order.
 * Provider call IDs inside content, model/agent, values, and state stay intact. */
export function value(messages: ReadonlyArray<SessionMessage.Message>) {
  return BlackboxTape.json(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
      JSON.stringify(
        messages.map((message) =>
          Object.fromEntries(
            Object.entries(message)
              .filter(([key]) => !["id", "time", "snapshot", "ttft"].includes(key))
              .map(([key, data]) => [
                key,
                key === "error" && message.type === "assistant" && message.error
                  ? { type: message.error.type }
                  : key === "content" && message.type === "assistant"
                    ? message.content.map((part) =>
                        Object.fromEntries(Object.entries(part).filter(([field]) => field !== "time")),
                      )
                    : data,
              ]),
          ),
        ),
      ),
    ),
  )
}

export const checkpoint = Effect.fn("Blackbox.checkpoint")(function* <E, R>(
  sessionID: string,
  kind: string,
  history: Effect.Effect<ReadonlyArray<SessionMessage.Message>, E, R>,
  database?: Database.Interface["db"],
) {
  const port = yield* SessionBlackbox.Current
  if (!port) return
  const tape = yield* Effect.promise(() => port.get(sessionID))
  const messages = value(yield* history)
  const pending = database
    ? yield* SessionInput.pending(database, { sessionID: SessionSchema.ID.make(sessionID), limit: 1000 })
    : undefined
  if (pending?.hasMore) yield* Effect.die(new Error("Blackbox checkpoint exceeds 1000 pending inputs"))
  const data = BlackboxTape.json(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
      JSON.stringify({
        messages,
        pending: pending?.inputs.map((input) => ({ prompt: input.prompt, delivery: input.delivery })) ?? [],
      }),
    ),
  )
  if (tape instanceof BlackboxTape.Replay) {
    yield* Effect.sync(() => tape.expectTrace("root", kind, data))
    return
  }
  yield* Effect.promise(() => tape.trace({ session: "root", kind, data, recordedAtMs: null }))
})
