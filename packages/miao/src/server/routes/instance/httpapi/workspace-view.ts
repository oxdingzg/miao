import { Schema } from "effect"
import { ProjectV2 } from "@miao/core/project"
import { WorkspaceV2 } from "@miao/core/workspace"
import type { DeepMutable } from "@miao/core/schema"

export const WorkspaceInfo = Schema.Struct({
  id: WorkspaceV2.ID,
  type: Schema.String,
  name: Schema.String,
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  directory: Schema.optional(Schema.NullOr(Schema.String)),
  extra: Schema.optional(Schema.NullOr(Schema.Unknown)),
  projectID: ProjectV2.ID,
}).annotate({ identifier: "Workspace" })
export type WorkspaceInfo = DeepMutable<Schema.Schema.Type<typeof WorkspaceInfo>>

/**
 * View model kept in the generated legacy SDK. No route returns it any more —
 * the V1 workspace service is retired — but the shape must not change.
 */
export const Workspace = {
  Info: Schema.Struct({
    ...WorkspaceInfo.fields,
    timeUsed: Schema.Number,
  }).annotate({ identifier: "Workspace" }),
} as const
