import { Schema } from "effect"
import { SessionRecovery } from "@miao/schema/session-recovery"
import { NonNegativeInt } from "@miao/schema/schema"

const Resolution = Schema.Struct({
  operation_id: SessionRecovery.OperationID,
  call_id: Schema.String,
  run_id: Schema.String,
  decision: SessionRecovery.Decision,
  input_id: Schema.String,
  admitted_seq: NonNegativeInt,
  outcome: Schema.Literal("unknown"),
})

export function resolution(value: unknown) {
  const result = Schema.decodeUnknownSync(Resolution)(value)
  return SessionRecovery.Resolution.make({
    operationID: result.operation_id,
    callID: result.call_id,
    runID: result.run_id,
    decision: result.decision,
    inputID: result.input_id,
    admittedSeq: result.admitted_seq,
    outcome: result.outcome,
  })
}

const Page = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({
      call_id: Schema.String,
      run_id: Schema.String,
      tool: Schema.String,
      outcome: Schema.Literal("unknown"),
      resolution: Schema.NullOr(Resolution),
    }),
  ).check(Schema.isMaxLength(100)),
  has_more: Schema.Boolean,
})

export function page(value: unknown) {
  const result = Schema.decodeUnknownSync(Page)(value)
  return SessionRecovery.Page.make({
    calls: result.calls.map((call) => ({
      callID: call.call_id,
      runID: call.run_id,
      tool: call.tool,
      outcome: call.outcome,
      resolution: call.resolution === null ? null : resolution(call.resolution),
    })),
    hasMore: result.has_more,
  })
}

export * as NativeRecovery from "./recovery"
