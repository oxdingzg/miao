import { Catalog } from "@miao/core/catalog"
import { Location } from "@miao/core/location"
import { LocationServiceMap } from "@miao/core/location-services"
import { PermissionSaved } from "@miao/core/permission/saved"
import { PluginV2 } from "@miao/core/plugin"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { WorkspaceV2 } from "@miao/core/workspace"
import { Deferred, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

// Project and the saved-permission store are resolved once per server build and
// reused by handlers that need them directly, in addition to the per-request
// location services.
export type LocationServices =
  | Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>
  | Project.Service
  | PermissionSaved.Service

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@miao/HttpApiLocation",
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

/**
 * The location's catalog, once the plugins that build it have loaded. A location
 * boots its plugins while it answers its first requests, and the catalog is what
 * those plugins produce, so a listing read any earlier would answer with the
 * catalog the location starts from: no providers, or a provider's own model list
 * with the entries its key cannot call still in it.
 */
export const bootedCatalog = Effect.gen(function* () {
  yield* booted
  return yield* Catalog.Service
})

/**
 * Waits for the location's plugins to finish booting. Agents, commands and
 * skills are contributed by plugins too, so their first listing has the same
 * window as the catalog.
 */
export const booted = Effect.gen(function* () {
  const plugins = yield* PluginV2.Service
  yield* Deferred.await(plugins.booted)
})

function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-opencode-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    ...(workspaceID ? { workspaceID: WorkspaceV2.ID.make(workspaceID) } : {}),
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const project = yield* Project.Service
    const permissions = yield* PermissionSaved.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* effect.pipe(
          Effect.provide(locations.get(ref(request))),
          Effect.provideService(Project.Service, project),
          Effect.provideService(PermissionSaved.Service, permissions),
        )
      }),
    )
  }),
)
