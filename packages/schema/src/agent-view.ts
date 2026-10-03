export * as AgentView from "./agent-view"

import { Schema, Types } from "effect"
import { Model as ModelV2 } from "./model"
import { PermissionV1 } from "./permission-v1"
import { Provider as ProviderV2 } from "./provider"

// The V1 agent view model projected to clients.
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>
export const Agent = Info
export type Agent = Info
