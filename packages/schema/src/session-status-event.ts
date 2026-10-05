export * as SessionStatusEvent from "./session-status-event"

import { Event } from "./event"
import { SessionID } from "./session-id"
import { StatusInfo } from "./session-event"

// The compat `session.status` event carries the same status shape as the
// current `session.next.status` event. Keep one canonical definition in
// `session-event.ts` rather than a second one here.
export const Info = StatusInfo
export type Info = StatusInfo

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Status, Idle)

// Compatibility name for the session status view model.
export type SessionStatus = Info
