export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@miao/schema/event"
import { EventManifest } from "@miao/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
