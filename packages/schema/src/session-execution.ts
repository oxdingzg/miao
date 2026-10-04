export * as SessionExecution from "./session-execution"

import { Schema } from "effect"

/** Ephemeral process-unique drain identity; distinct from durable Session IDs. */
export const ID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).annotate({ identifier: "SessionExecution.ID" })
export type ID = typeof ID.Type

export const State = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("running"), executionID: ID }),
]).annotate({ identifier: "SessionExecution.State" })
export type State = typeof State.Type
