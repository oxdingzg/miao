export * as ConfigEvent from "./config-event"

import { Event } from "./event"

/** The user's global config was rewritten; locations opened from now on read the new values. */
export const Updated = Event.define({ type: "config.updated", schema: {} })

export const Definitions = Event.inventory(Updated)
