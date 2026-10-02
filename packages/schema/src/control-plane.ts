export * as ControlPlane from "./control-plane"

import { Schema } from "effect"
import { AbsolutePath, optional } from "./schema"
import { Session } from "./session"

export const MoveSessionDestination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "ControlPlane.MoveSessionDestination" })
export interface MoveSessionDestination extends Schema.Schema.Type<typeof MoveSessionDestination> {}

export const MoveSessionInput = Schema.Struct({
  sessionID: Session.ID,
  destination: MoveSessionDestination,
  moveChanges: optional(Schema.Boolean),
}).annotate({ identifier: "ControlPlane.MoveSessionInput" })
export interface MoveSessionInput extends Schema.Schema.Type<typeof MoveSessionInput> {}
