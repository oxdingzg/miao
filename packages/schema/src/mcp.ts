export * as MCP from "./mcp"

import { Schema } from "effect"

export interface StatusConnected extends Schema.Schema.Type<typeof StatusConnected> {}
export const StatusConnected = Schema.Struct({
  status: Schema.Literal("connected"),
}).annotate({ identifier: "McpServerStatusConnected" })

export interface StatusDisabled extends Schema.Schema.Type<typeof StatusDisabled> {}
export const StatusDisabled = Schema.Struct({
  status: Schema.Literal("disabled"),
}).annotate({ identifier: "McpServerStatusDisabled" })

export interface StatusFailed extends Schema.Schema.Type<typeof StatusFailed> {}
export const StatusFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.String,
}).annotate({ identifier: "McpServerStatusFailed" })

export interface StatusNeedsAuth extends Schema.Schema.Type<typeof StatusNeedsAuth> {}
export const StatusNeedsAuth = Schema.Struct({
  status: Schema.Literal("needs_auth"),
}).annotate({ identifier: "McpServerStatusNeedsAuth" })

export interface StatusNeedsClientRegistration extends Schema.Schema.Type<typeof StatusNeedsClientRegistration> {}
export const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "McpServerStatusNeedsClientRegistration" })

export type Status =
  | StatusConnected
  | StatusDisabled
  | StatusFailed
  | StatusNeedsAuth
  | StatusNeedsClientRegistration

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "McpServerStatus", discriminator: "status" })
