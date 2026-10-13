import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { ProjectV2 } from "@miao/core/project"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { ProjectRegistry } from "@miao/core/project/registry"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import type { Project } from "@miao/schema/project"

export interface ProjectContext {
  directory: string
  worktree: string
  project: Project.Info
}

/**
 * Resolves the working directory to its registered project and the checkout
 * to treat as the worktree — the core equivalent of the V1 instance context
 * these commands used to read. `ProjectDirectories`/`ProjectMetadata` are
 * provided here because the app layer only reaches them through the V1
 * instance store.
 */
export const projectContext = (directory: string = process.cwd()) =>
  Effect.gen(function* () {
    const registry = yield* Effect.context<Database.Service | EventV2.Service | FSUtil.Service>()
    const result = yield* ProjectRegistry.registerDirectory(directory).pipe(Effect.provideContext(registry))
    return { directory, worktree: result.sandbox, project: result.project }
  }).pipe(
    Effect.orDie,
    Effect.provide(
      LayerNode.compile(LayerNode.group([ProjectV2.node, ProjectDirectories.node, ProjectMetadata.node])),
    ),
  )

/** Open the working directory's location scope; core services resolve inside it. */
export const locationScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
    ),
    Effect.provide(locationServiceMapLayer),
  )
