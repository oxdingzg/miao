export * as EventView from "./event-view"

import type { Schema } from "effect"
import type { EventManifest } from "./event-manifest"
import type { StripBrand } from "./view-models"

// The UI's properties-shaped envelope is a projection of the event inventory,
// including the compatibility events still used by local transcript reducers.
export type V2Event = StripBrand<Schema.Codec.Encoded<(typeof EventManifest.Definitions)[number]>>
export type Event =
  | Properties<V2Event>
  | {
      id: string
      type: "server.instance.disposed"
      properties: { directory: string }
    }

type Properties<T> = T extends { id: string; type: string; data: unknown }
  ? { id?: string; type: T["type"]; properties: T["data"] }
  : never
