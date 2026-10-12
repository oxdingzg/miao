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

/**
 * Native-owned evidence of one prepared provider HTTP attempt, delivered to
 * clients as observability. `requestBodySha256` and `profile` are the actual
 * serialized request and its authority snapshot; `agent`/`permissions` are the
 * executing runtime's facts, never a catalog identity. Nested objects stay
 * opaque here because the engine, not the client, owns their schema.
 */
export const ProviderRequest = Event.define({
  type: "session.next.provider.request",
  schema: {
    sessionID: SessionID,
    timestamp: DateTimeUtcFromMillis,
    runID: Schema.String,
    step: NonNegativeInt,
    contextEpoch: NonNegativeInt,
    attempt: NonNegativeInt,
    protocol: Schema.String,
    requestBodySha256: Schema.String,
    agent: Schema.Unknown,
    permissions: Schema.Unknown,
    profile: Schema.Unknown,
  },
})

/**
 * The observed outcome of one prepared attempt. `requestSeq` is the durable
 * sequence of its `provider.request` event; `httpStatus` is null when the
 * attempt never received response headers, and `outcome` names why.
 */
export const ProviderRequestResult = Event.define({
  type: "session.next.provider.request.result",
  schema: {
    sessionID: SessionID,
    timestamp: DateTimeUtcFromMillis,
    runID: Schema.String,
    step: NonNegativeInt,
    requestSeq: NonNegativeInt,
    httpStatus: Schema.NullOr(NonNegativeInt),
    outcome: Schema.String,
  },
})

export const Definitions = Event.inventory(AssistantIdentity, ProviderRequest, ProviderRequestResult)
