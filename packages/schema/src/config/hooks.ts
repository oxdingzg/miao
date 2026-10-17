export * as ConfigHooks from "./hooks"

import { Schema } from "effect"

export const EVENTS = [
  "session_start",
  "user_prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "permission_denied",
  "subagent_start",
  "subagent_stop",
  "pre_compact",
  "post_compact",
  "stop",
  "stop_failure",
  "instructions_loaded",
] as const

export class Entry extends Schema.Class<Entry>("ConfigV2.Hooks.Entry")({
  event: Schema.Literals([...EVENTS]).annotate({
    description: "Lifecycle event that triggers the hook.",
  }),
  tool: Schema.String.pipe(Schema.optional).annotate({
    description: "Tool name selector for tool-scoped events; defaults to all tools.",
  }),
  command: Schema.Array(Schema.String).annotate({
    description: "Argv executed under the same sandbox as bash. Never a shell string.",
  }),
  timeout_ms: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 60000 }))
    .pipe(Schema.optional)
    .annotate({
      description: "Hook time budget in milliseconds (default 10000).",
    }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Hooks")({
  entries: Schema.Array(Entry).annotate({
    description: "Lifecycle hooks the native engine executes as observation guards.",
  }),
}) {}
