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

const Call = Schema.Struct({
  call_id: Schema.String,
  run_id: Schema.String,
  tool: Schema.String,
  outcome: Schema.Literal("unknown"),
  origin: Schema.optional(Schema.Literals(["model", "operator"])),
  resolution: Schema.NullOr(Resolution),
})

function call(result: Schema.Schema.Type<typeof Call>) {
  return {
    callID: result.call_id,
    runID: result.run_id,
    tool: result.tool,
    outcome: result.outcome,
    ...(result.origin === undefined ? {} : { origin: result.origin }),
    resolution: result.resolution === null ? null : resolution(result.resolution),
  }
}

const Page = Schema.Struct({
  calls: Schema.Array(Call).check(Schema.isMaxLength(100)),
  has_more: Schema.Boolean,
})

export function page(value: unknown) {
  const result = Schema.decodeUnknownSync(Page)(value)
  return SessionRecovery.Page.make({
    calls: result.calls.map(call),
    hasMore: result.has_more,
  })
}

const Inspection = Schema.Struct({
  ...Call.fields,
  input: Schema.Unknown,
})

export function inspection(value: unknown) {
  const result = Schema.decodeUnknownSync(Inspection)(value)
  return SessionRecovery.Inspection.make({ ...call(result), input: result.input })
}

export * as NativeRecovery from "./recovery"
