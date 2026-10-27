import { Database } from "@miao/core/database/database"
import type { EventV2 } from "@miao/core/event"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionInput } from "@miao/core/session/input"
import { DateTime, Effect, Option, Schema } from "effect"
import { SessionEvent } from "@miao/schema/session-event"
import { SessionID } from "@miao/schema/session-id"
import { SessionInput as SessionInputSchema } from "@miao/schema/session-input"
import { SessionMessage } from "@miao/schema/session-message"
import { AgentAttachment } from "@miao/schema/prompt"
import type { EngineEvent } from "./client"
import { decodeAttachments } from "./prompt-attachments"

export interface ProjectionDeps {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  /** Advisory drain for the TS runner; absent deps keep the projection read-only. */
  readonly wake?: (sessionID: SessionID) => Effect.Effect<void>
}

const AdmittedInput = Schema.Struct({
  input_id: Schema.String,
  delivery: SessionInputSchema.Delivery,
  prompt: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  agent_references: Schema.optional(
    Schema.Struct({ mentions: Schema.optional(Schema.Array(AgentAttachment)) }),
  ),
})

/**
 * The sole writer of `session_input` while the engine owns every inbox:
 * one durable `input.admitted` event projects into one `PromptAdmitted`
 * journal event, and the TS runner drains the projection it always read.
 * Replayed events dedupe against the stored row, so reconnect replays and
 * double delivery stay idempotent (specs/s2-single-inbox.md §3.2).
 */
export const projectInputAdmitted = Effect.fn("Engine.projectInputAdmitted")(function* (
  deps: ProjectionDeps,
  event: EngineEvent,
) {
  if (event.kind !== "input.admitted") return false
  const sessionID = Schema.decodeUnknownOption(SessionID)(event.session_id)
  if (Option.isNone(sessionID)) return false
  const placement = yield* SessionEnginePlacement.find(deps.db, sessionID.value)
  // A natively executed Session keeps its inbox in the engine; only
  // TS-owned placements read the projected copy.
  if (placement?.engine === "rust") return false
  const data = Schema.decodeUnknownOption(AdmittedInput)(event.data)
  if (Option.isNone(data)) return false
  const id = Schema.decodeUnknownOption(SessionMessage.ID)(data.value.input_id)
  if (Option.isNone(id)) return false
  const stored = yield* SessionInput.find(deps.db, id.value)
  if (stored !== undefined) return false
  const files = data.value.attachments === undefined ? [] : decodeAttachments(data.value.attachments)
  const mentions = data.value.agent_references?.mentions ?? []
  yield* deps.events.publish(SessionEvent.PromptAdmitted, {
    messageID: id.value,
    sessionID: sessionID.value,
    timestamp:
      typeof event.recorded_at_ms === "number"
        ? DateTime.makeUnsafe(event.recorded_at_ms)
        : yield* DateTime.now,
    prompt: {
      text: data.value.prompt,
      ...(files.length ? { files } : {}),
      ...(mentions.length ? { agents: mentions } : {}),
    },
    delivery: data.value.delivery,
  })
  if (deps.wake) yield* deps.wake(sessionID.value)
  return true
})
