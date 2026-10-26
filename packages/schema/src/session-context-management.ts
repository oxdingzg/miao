export * as SessionContextManagement from "./session-context-management"

import { Option, Schema } from "effect"
import { NonNegativeInt } from "./schema"
import { SessionExecution } from "./session-execution"

/** Measured request-only tool payloads, including replacement marker bytes. */
export const Pruning = Schema.Struct({
  executionID: SessionExecution.ID,
  step: NonNegativeInt,
  contextEpoch: NonNegativeInt,
  reason: Schema.Literal("tool_output_budget"),
  scope: Schema.Literal("tool_result_payloads"),
  unit: Schema.Literal("utf8_bytes"),
  payloads: NonNegativeInt,
  messages: NonNegativeInt,
  beforeBytes: NonNegativeInt,
  afterBytes: NonNegativeInt,
  savedBytes: NonNegativeInt,
}).annotate({ identifier: "Session.Context.Pruning" })
export type Pruning = typeof Pruning.Type

/** Cross-field checks stay outside the portable transport schema. */
export function decodePruning(value: unknown) {
  const parsed = Schema.decodeUnknownOption(Pruning)(value)
  if (Option.isNone(parsed)) return
  if (
    parsed.value.payloads < 1 ||
    parsed.value.messages < 1 ||
    parsed.value.messages > parsed.value.payloads ||
    parsed.value.savedBytes < 1
  )
    return
  if (
    parsed.value.afterBytes > parsed.value.beforeBytes ||
    parsed.value.savedBytes !== parsed.value.beforeBytes - parsed.value.afterBytes
  )
    return
  return parsed.value
}
