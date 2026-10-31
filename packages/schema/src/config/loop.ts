export * as ConfigLoop from "./loop"

import { Schema } from "effect"

/**
 * Todo-driven autonomous loop. By default the runner keeps admitting a
 * continuation prompt while the session's todo list still has runnable items,
 * up to `max_iterations`, so an agent can work round after round without new
 * user input. `enabled: false` disables continuation entirely; a recorded
 * session goal that is not active also stops it.
 */
export class Info extends Schema.Class<Info>("ConfigV2.Loop")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  max_iterations: Schema.Number.pipe(Schema.optional),
  continue_prompt: Schema.String.pipe(Schema.optional),
}) {}
