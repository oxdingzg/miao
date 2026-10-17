export * as SessionRecovery from "./session-recovery"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

export const Decision = Schema.Literals(["retry", "abandon"]).annotate({ identifier: "SessionRecovery.Decision" })
export type Decision = typeof Decision.Type
export const OperationID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
  .pipe(Schema.brand("SessionRecovery.OperationID"))
  .annotate({ identifier: "SessionRecovery.OperationID" })
export type OperationID = typeof OperationID.Type

export const Resolution = Schema.Struct({
  operationID: OperationID,
  callID: Schema.String,
  runID: Schema.String,
  decision: Decision,
  inputID: Schema.String,
  admittedSeq: NonNegativeInt,
  outcome: Schema.Literal("unknown"),
}).annotate({ identifier: "SessionRecovery.Resolution" })
export interface Resolution extends Schema.Schema.Type<typeof Resolution> {}

export const Call = Schema.Struct({
  callID: Schema.String,
  runID: Schema.String,
  tool: Schema.String,
  outcome: Schema.Literal("unknown"),
  resolution: Schema.NullOr(Resolution),
}).annotate({ identifier: "SessionRecovery.Call" })
export interface Call extends Schema.Schema.Type<typeof Call> {}

export const Page = Schema.Struct({
  calls: Schema.Array(Call),
  hasMore: Schema.Boolean,
}).annotate({ identifier: "SessionRecovery.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}
