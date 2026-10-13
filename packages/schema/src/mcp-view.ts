export * as McpView from "./mcp-view"

import { Schema } from "effect"

// The V1 MCP status view model kept for the generated legacy SDK. No route
// returns it any more; the V2 runtime reports connection state separately.
const Connected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const Disabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const Failed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const NeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const NeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([Connected, Disabled, Failed, NeedsAuth, NeedsClientRegistration]).annotate({
  identifier: "MCPStatus",
  discriminator: "status",
})
export type Status = Schema.Schema.Type<typeof Status>
