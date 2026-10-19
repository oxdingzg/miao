import { Option, Schema } from "effect"
import { SessionMessage } from "@miao/schema/session-message"
import { messageID } from "./identity"
import type { EngineEvent } from "./client"

const Promoted = Schema.Struct({ input_id: Schema.String, command: Schema.optional(Schema.Unknown) })
const Committed = Schema.Struct({
  role: Schema.String,
  anchor_seq: Schema.optional(Schema.Number),
  input_id: Schema.optional(Schema.String),
})

/** Resolve public IDs without mistaking a provider anchor for a message cut. */
export function engineMessageSequence(sessionID: string, requested: SessionMessage.ID, events: readonly EngineEvent[]) {
  for (const event of events) {
    if (event.session_id !== sessionID) continue
    if (event.kind === "input.promoted") {
      const data = Schema.decodeUnknownSync(Promoted)(event.data)
      const id = data.input_id.startsWith("msg_") ? data.input_id : messageID(sessionID, event.seq)
      if (id === requested) {
        if (typeof data.command === "object" && data.command !== null)
          return events.find(
            (item) =>
              item.session_id === sessionID &&
              (item.kind === "command.completed" || item.kind === "command.failed") &&
              typeof item.data === "object" &&
              item.data !== null &&
              "input_id" in item.data &&
              item.data.input_id === data.input_id,
          )?.seq
        return event.seq
      }
    }
    if (event.kind === "shell.started") {
      const started = Schema.decodeUnknownOption(Schema.Struct({ call_id: Schema.String }))(event.data)
      if (
        Option.isSome(started) &&
        (started.value.call_id === requested || messageID(sessionID, event.seq) === requested)
      ) {
        const ended = events.find(
          (item) =>
            item.kind === "shell.ended" &&
            typeof item.data === "object" &&
            item.data !== null &&
            "call_id" in item.data &&
            item.data.call_id === started.value.call_id,
        )
        if (ended) return ended.seq
      }
    }
    if (event.kind === "shell.started") {
      const started = Schema.decodeUnknownOption(Schema.Struct({ call_id: Schema.String }))(event.data)
      if (
        Option.isSome(started) &&
        (started.value.call_id === requested || messageID(sessionID, event.seq) === requested)
      ) {
        const ended = events.find(
          (item) =>
            item.kind === "shell.ended" &&
            typeof item.data === "object" &&
            item.data !== null &&
            "call_id" in item.data &&
            item.data.call_id === started.value.call_id,
        )
        if (ended) return ended.seq
      }
    }
    if (event.kind === "message.synthetic" && messageID(sessionID, event.seq) === requested) return event.seq
    if (event.kind === "message.committed") {
      const data = Schema.decodeUnknownSync(Committed)(event.data)
      if (
        data.role === "user" &&
        data.input_id &&
        (data.input_id === requested || messageID(sessionID, event.seq) === requested)
      )
        return event.seq
      if (data.role === "assistant" && messageID(sessionID, data.anchor_seq ?? event.seq) === requested)
        return event.seq
    }
  }
  return undefined
}
