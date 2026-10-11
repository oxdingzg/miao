export * as EngineEvent from "./engine-event"

import { Event } from "./event"
import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

/** Native-owned evidence delivered to clients, never a TS journal mutation. */
export const AssistantIdentity = Event.define({
  type: "session.next.assistant.identity",
  schema: {
    sessionID: SessionID,
    timestamp: DateTimeUtcFromMillis,
    assistantMessageID: SessionMessage.ID,
    assistantSeq: NonNegativeInt,
    provider: Schema.NullOr(Schema.Struct({ protocol: Schema.String, model: Schema.String })),
    // Wire protocol/model facts do not establish product catalog or agent identities.
    model: Schema.Null,
    agent: Schema.Null,
  },
})

export const Definitions = Event.inventory(AssistantIdentity)
