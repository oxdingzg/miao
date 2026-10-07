export * as EditSnapshots from "./edit-snapshot"

import { Context, Effect, Layer, Option } from "effect"
import { makeLocationNode } from "../effect/app-node"

const MAX_FILES = 24
const MAX_CHARS = 512 * 1024

export interface Interface {
  /** Records the text the model last saw for a file, replacing any earlier snapshot. */
  register: (file: string, text: string) => Effect.Effect<void>
  lookup: (file: string) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/EditSnapshots") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const snapshots = new Map<string, string>()
    return Service.of({
      register: (file, text) =>
        Effect.sync(() => {
          if (text.length > MAX_CHARS) return
          snapshots.delete(file)
          snapshots.set(file, text)
          for (const oldest of snapshots.keys()) {
            if (snapshots.size <= MAX_FILES) break
            snapshots.delete(oldest)
          }
        }),
      lookup: (file) =>
        Effect.sync(() => {
          const text = snapshots.get(file)
          return text === undefined ? Option.none<string>() : Option.some(text)
        }),
    })
  }),
)

export const node = makeLocationNode({ name: "tool/edit-snapshot", layer, deps: [] })
