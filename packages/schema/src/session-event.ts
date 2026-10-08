export * as SessionEvent from "./session-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { ProviderMetadata, ToolContent } from "./llm"
import { Delivery } from "./session-delivery"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, RelativePath } from "./schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionID } from "./session-id"
import { Location } from "./location"
import { SessionMessage } from "./session-message"
import { SessionInfo } from "./session-info"
import { Revert } from "./revert"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}
const PromptFields = {
  ...Base,
  messageID: SessionMessage.ID,
  prompt: Prompt,
  delivery: Delivery,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

export const UnknownError = SessionMessage.UnknownError
export type UnknownError = SessionMessage.UnknownError

export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    model: Model.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(optional),
  },
})
export type Moved = typeof Moved.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...options,
  schema: PromptFields,
})
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = Event.define({
  type: "session.next.prompt.admitted",
  ...options,
  schema: PromptFields,
})
export type PromptAdmitted = typeof PromptAdmitted.Type

export const PromptCancelled = Event.define({
  type: "session.next.prompt.cancelled",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
  },
})
export type PromptCancelled = typeof PromptCancelled.Type

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  },
})
export type Synthetic = typeof Synthetic.Type

/** Background delegation is durable work, separate from user prompt admission. */
export const DelegationStarted = Event.define({
  type: "session.next.delegation.started",
  ...options,
  schema: {
    ...Base,
    id: Schema.String,
    childSessionID: SessionID,
    promptMessageID: SessionMessage.ID,
    agent: Schema.String,
    prompt: Schema.String,
    description: Schema.String,
    owner: Schema.String,
  },
})
export type DelegationStarted = typeof DelegationStarted.Type

export const DelegationEnded = Event.define({
  type: "session.next.delegation.ended",
  ...options,
  schema: {
    ...Base,
    id: Schema.String,
    status: Schema.Literals(["completed", "failed", "interrupted", "cancelled"]),
    text: Schema.String,
  },
})
export type DelegationEnded = typeof DelegationEnded.Type

/**
 * An interim note a running background subagent sends its parent. It is
 * projected as an ordinary notification, so the parent reads it at its next
 * safe boundary; unlike `DelegationEnded` it does not settle the delegation.
 */
export const DelegationReported = Event.define({
  type: "session.next.delegation.reported",
  ...options,
  schema: {
    ...Base,
    id: Schema.String,
    childSessionID: SessionID,
    text: Schema.String,
  },
})
export type DelegationReported = typeof DelegationReported.Type

export namespace Command {
  export const Started = Event.define({
    type: "session.next.command.started",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID },
  })
  export const Completed = Event.define({
    type: "session.next.command.completed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID, prompt: Prompt },
  })
  export const Failed = Event.define({
    type: "session.next.command.failed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID, error: Schema.String, text: Schema.String },
  })
}

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      /** Absent on events settled before the model was recorded here; the step's `Started` event carries it. */
      model: Model.Ref.pipe(optional),
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      snapshot: Schema.String.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
      /** Time to the provider's first streamed event, absent when no attempt reported one. */
      ttft: Schema.Finite.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
      outputPaths: Schema.Array(Schema.String).pipe(optional),
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: UnknownError,
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(optional),
  responseBody: Schema.String.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export interface RetryError extends Schema.Schema.Type<typeof RetryError> {}

export const Retried = Event.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

/**
 * Where an active drain currently is. `queued` is owned but waiting on a
 * concurrency slot; `preparing` is local turn work (history, model, tools,
 * request build, compaction, snapshot); `requesting` is a dispatched request
 * awaiting the provider's first event (TTFT); `streaming` is at least one
 * provider event received; `retrying` is a bounded retry of a failed attempt.
 */
export const BusyPhase = Schema.Literals(["queued", "preparing", "requesting", "streaming", "retrying"]).annotate({
  identifier: "session.next.busy_phase",
})
export type BusyPhase = Schema.Schema.Type<typeof BusyPhase>

/**
 * Whether this process is draining the Session; the same shape
 * `GET /api/session/:sessionID/status` returns. A `busy` carries the drain
 * phase so a client can tell local preparation from a dispatched provider
 * request: `phase` and `since` are optional so optimistic client writes and
 * older producers stay valid, and a missing `phase` reads as `preparing`.
 * A `retry` is the `retrying` phase with the attempt detail a client renders.
 */
export const StatusInfo = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
    phase: BusyPhase.pipe(optional),
    /** Epoch millis when the current phase began. */
    since: Schema.Finite.pipe(optional),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: Schema.Struct({
      reason: Schema.String,
      provider: Schema.String,
      title: Schema.String,
      message: Schema.String,
      label: Schema.String,
      link: optional(Schema.String),
    }).pipe(optional),
    next: NonNegativeInt,
  }),
]).annotate({
  identifier: "session.next.status_info",
})
export type StatusInfo = Schema.Schema.Type<typeof StatusInfo>

// Live process state, published on each busy/idle transition and never stored.
// A client that (re)subscribes reads the current value from the status route.
export const Status = Event.define({
  type: "session.next.status",
  schema: {
    ...Base,
    status: StatusInfo,
  },
})
export type Status = typeof Status.Type

// A model-initiated request for the human's attention. Like live process state
// this is a signal rather than session state, so it is never stored: a client
// that was not connected when it fired has nothing to replay, and the terminal
// and remote-control fan-outs both treat it as a best-effort hint.
export const Notified = Event.define({
  type: "session.next.notified",
  schema: {
    ...Base,
    /** Defaults to the Session title when the caller does not name the subject. */
    title: optional(Schema.String),
    message: Schema.String,
  },
})
export type Notified = typeof Notified.Type

// A drain failed outside any provider step. Provider and model-resolution
// failures are already recorded on the assistant message as `step.failed`, so
// they never produce this event; everything else that ends a drain does.
export const Failed = Event.define({
  type: "session.next.failed",
  schema: {
    ...Base,
    error: UnknownError,
    /** Tag of the underlying error when it has one, e.g. `Session.LegacyNotMigratedError`. */
    name: Schema.String.pipe(optional),
  },
})
export type Failed = typeof Failed.Type

export namespace Compaction {
  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace RevertEvent {
  export const Staged = Event.define({
    type: "session.next.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert.State },
  })
  export const Cleared = Event.define({ type: "session.next.revert.cleared", ...options, schema: Base })
  export const Committed = Event.define({
    type: "session.next.revert.committed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID },
  })
}

export namespace Info {
  export const Created = Event.define({
    type: "session.next.created",
    ...options,
    schema: {
      ...Base,
      info: SessionInfo.Info,
      slug: Schema.String,
      version: Schema.String,
    },
  })
  export type Created = typeof Created.type

  export const Updated = Event.define({
    type: "session.next.info.updated",
    ...options,
    schema: {
      ...Base,
      title: Schema.String.pipe(optional),
      archived: Schema.Boolean.pipe(optional),
    },
  })
  export type Updated = typeof Updated.type
}

export const DurableDefinitions = Event.inventory(
  Info.Created,
  Info.Updated,
  AgentSwitched,
  ModelSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  PromptCancelled,
  ContextUpdated,
  Synthetic,
  DelegationStarted,
  DelegationEnded,
  DelegationReported,
  Command.Started,
  Command.Completed,
  Command.Failed,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Compaction.Started,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Definitions = Event.inventory(
  Info.Created,
  Info.Updated,
  AgentSwitched,
  ModelSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  PromptCancelled,
  ContextUpdated,
  Synthetic,
  DelegationStarted,
  DelegationEnded,
  DelegationReported,
  Command.Started,
  Command.Completed,
  Command.Failed,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Retried,
  Status,
  Notified,
  Failed,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
