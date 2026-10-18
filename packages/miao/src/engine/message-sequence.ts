import { Schema } from "effect"
import { SessionMessage } from "@miao/schema/session-message"
import { messageID } from "./identity"
import type { EngineEvent } from "./client"

const Promoted = Schema.Struct({ input_id: Schema.String })
const Committed = Schema.Struct({ role: Schema.String, anchor_seq: Schema.optional(Schema.Number) })

/** Resolve public IDs without mistaking a provider anchor for a message cut. */
export function engineMessageSequence(sessionID: string, requested: SessionMessage.ID, events: readonly EngineEvent[]) {
  for (const event of events) {
    if (event.session_id !== sessionID) continue
    if (event.kind === "input.promoted") {
      const data = Schema.decodeUnknownSync(Promoted)(event.data)
      const id = data.input_id.startsWith("msg_") ? data.input_id : messageID(sessionID, event.seq)
      if (id === requested) return event.seq
    }
    if (event.kind === "message.synthetic" && messageID(sessionID, event.seq) === requested) return event.seq
    if (event.kind === "message.committed") {
      const data = Schema.decodeUnknownSync(Committed)(event.data)
      if (data.role === "assistant" && messageID(sessionID, data.anchor_seq ?? event.seq) === requested)
        return event.seq
    }
  }
  return undefined
}
