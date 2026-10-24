export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

/** Token count as a plain number or a shorthand string ("300K", "1.5M", "50%"). */
export const Budget = Schema.Union([Schema.Number, Schema.String])
export type Budget = number | string

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  hot_prefix: Schema.Boolean.pipe(Schema.optional),
  precise_tokens: Schema.Boolean.pipe(Schema.optional),
  summarize_small: Schema.Boolean.pipe(Schema.optional),
  /** Fraction of the context window that triggers auto-compaction (default 0.9). */
  threshold: Schema.Number.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  /**
   * Work in a smaller window than the model declares, to bound cost or latency.
   * One value for every model, or a map keyed by "<providerID>/<modelID>" where
   * `*` and `?` globs are allowed and the longest matching key wins. The value
   * is clamped to the model's real window, never raises it, and `0` restores
   * the model default (a config merge cannot delete a key).
   */
  max_context: Schema.Union([Budget, Schema.Record(Schema.String, Budget)]).pipe(Schema.optional),
}) {}
