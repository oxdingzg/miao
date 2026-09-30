export * as Session from "./session"

import { Schema } from "effect"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

export { Info } from "./session-info"

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
