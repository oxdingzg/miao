export * as ConfigTools from "./tools"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Tools")({
  /** Force tool disclosure on or off; unset defers to the experimental flag. */
  disclosure: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Defer external tool schemas above the budget behind a stable tool_search tool",
  }),
  /** Tool names disclosure must keep advertised. */
  always_load: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "External tool names that stay resident instead of deferring behind tool_search",
  }),
}) {}
