export * as PermissionSaved from "./permission-saved"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("PermissionSaved.ID"),
  statics((schema) => ({ create: () => schema.make("psv_" + ascending()) })),
)
export type ID = typeof ID.Type

export const NativePrefix = "psv_native_"

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  action: Schema.String,
  resource: Schema.String,
  origin: Schema.Literal("native").pipe(Schema.optional),
  scope: Schema.Struct({ type: Schema.Literal("directory"), directory: Schema.String }).pipe(Schema.optional),
}).annotate({ identifier: "PermissionSaved.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// Compatibility name for the permission-saved view model.
export const PermissionSavedInfo = Info
export type PermissionSavedInfo = Info
