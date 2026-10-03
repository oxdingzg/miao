import { Context, Effect, Layer } from "effect"
import { Info, Ref, response } from "@miao/schema/location"
import { Project } from "./project"
import { LayerNode } from "./effect/layer-node"
import { makeLocationNode, tags } from "./effect/app-node"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
  /** The project ID cached in the repository before this resolution, when it differs from the current one. */
  readonly previous?: Project.ID
}

export class Service extends Context.Service<Service, Interface>()("@miao/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
        previous: resolved.previous === resolved.id ? undefined : resolved.previous,
      })
    }),
  )

export const boundNode = (ref: Ref) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node],
  })
