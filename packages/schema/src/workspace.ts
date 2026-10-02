export * as Workspace from "./workspace"

import { Schema } from "effect"
import { ProjectID } from "./project-id"
import { optional } from "./schema"
import { WorkspaceEvent } from "./workspace-event"
import { WorkspaceID } from "./workspace-id"

export const ID = WorkspaceID
export type ID = WorkspaceID

export const Info = Schema.Struct({
  id: ID,
  type: Schema.String,
  name: Schema.String,
  branch: optional(Schema.NullOr(Schema.String)),
  directory: optional(Schema.NullOr(Schema.String)),
  extra: optional(Schema.NullOr(Schema.Unknown)),
  projectID: ProjectID,
  timeUsed: Schema.Number,
}).annotate({ identifier: "Workspace.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const AdapterEntry = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  description: Schema.String,
}).annotate({ identifier: "Workspace.AdapterEntry" })
export interface AdapterEntry extends Schema.Schema.Type<typeof AdapterEntry> {}

export const CreateInput = Schema.Struct({
  type: Schema.String,
  branch: optional(Schema.NullOr(Schema.String)),
  extra: optional(Schema.NullOr(Schema.Unknown)),
}).annotate({ identifier: "Workspace.CreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const WarpInput = Schema.Struct({
  id: Schema.NullOr(ID),
  sessionID: Schema.String,
  copyChanges: optional(Schema.Boolean),
}).annotate({ identifier: "Workspace.WarpInput" })
export interface WarpInput extends Schema.Schema.Type<typeof WarpInput> {}

export const ConnectionStatus = WorkspaceEvent.ConnectionStatus
export type ConnectionStatus = WorkspaceEvent.ConnectionStatus

export const Event = WorkspaceEvent
