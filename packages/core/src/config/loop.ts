export * as ConfigLoop from "./loop"

import { Schema } from "effect"

/**
 * Goal/todo-driven autonomous loop. When enabled, the runner keeps admitting a
 * continuation prompt while the session's todo list still has open items, up to
 * `max_iterations`, so an agent can work round after round without new user input.
 */
export class Info extends Schema.Class<Info>("ConfigV2.Loop")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  max_iterations: Schema.Number.pipe(Schema.optional),
  continue_prompt: Schema.String.pipe(Schema.optional),
}) {}
