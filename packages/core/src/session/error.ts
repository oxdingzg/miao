import { Schema } from "effect"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

export class MessageDecodeError extends Schema.TaggedErrorClass<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Failed to decode message ${this.messageID} in session ${this.sessionID}`
  }
}

export class ContextSnapshotDecodeError extends Schema.TaggedErrorClass<ContextSnapshotDecodeError>()(
  "Session.ContextSnapshotDecodeError",
  {
    sessionID: SessionSchema.ID,
    details: Schema.String,
  },
) {
  override get message() {
    return `Failed to decode context snapshot for session ${this.sessionID}: ${this.details}`
  }
}

/**
 * A session still holds legacy V1 `message` / `part` history that was never
 * projected. Continuing it on V2 would run the provider against an empty
 * context, so writes are refused until the session is backfilled.
 */
export class LegacyNotMigratedError extends Schema.TaggedErrorClass<LegacyNotMigratedError>()(
  "Session.LegacyNotMigratedError",
  {
    sessionID: SessionSchema.ID,
    state: Schema.Literals(["legacy", "mixed"]),
  },
) {
  override get message() {
    return this.state === "legacy"
      ? `Session ${this.sessionID} predates the V2 runtime and has no V2 history projection. Run \`miao db backfill\` before continuing it.`
      : `Session ${this.sessionID} mixes legacy and V2 history and cannot be continued safely.`
  }
}
