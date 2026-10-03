import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { GitCli } from "@miao/core/git-cli"
import { LocationServiceMap } from "@miao/core/location-service-map"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { ProjectRegistry } from "@miao/core/project/registry"
import { ProjectNotFoundError, UnknownError } from "@miao/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.gen(function* () {
    const metadata = yield* ProjectMetadata.Service
    const git = yield* GitCli.Service
    const locations = yield* LocationServiceMap.Service
    const registry = yield* Effect.context<
      Database.Service | FSUtil.Service | ProjectDirectories.Service | EventV2.Service | ProjectV2.Service
    >()
    return handlers
      .handle("project.list", () => response(metadata.list()))
      .handle("project.current", () =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            const project = yield* ProjectV2.Service
            const resolved = yield* project.resolve(location.directory)
            return { id: resolved.id, directory: resolved.directory }
          }),
        ),
      )
      .handle("project.directories", (ctx) =>
        response(
          Effect.gen(function* () {
            const project = yield* ProjectV2.Service
            return yield* project.directories({ projectID: ctx.params.projectID })
          }),
        ),
      )
      .handle("project.update", (ctx) =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            const project = yield* ProjectV2.Service
            const resolved = yield* project.resolve(location.directory)
            if (resolved.id === ctx.params.projectID) yield* metadata.ensure(resolved)
            return yield* metadata.update(ctx.params.projectID, ctx.payload)
          }).pipe(
            Effect.catchTag("ProjectMetadata.NotFoundError", (error) =>
              Effect.fail(
                new ProjectNotFoundError({
                  projectID: error.projectID,
                  message: `Project not found: ${error.projectID}`,
                }),
              ),
            ),
          ),
        ),
      )
      .handle("project.initGit", () =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            if (!location.vcs) {
              const result = yield* git.run(["init", "--quiet"], { cwd: location.directory })
              if (result.exitCode !== 0)
                return yield* new UnknownError({
                  message: result.stderr.toString().trim() || "Failed to initialize a git repository",
                })
              // The open location resolved its project before the repository existed.
              yield* locations.invalidate({ directory: location.directory, workspaceID: location.workspaceID })
            }
            const project = yield* ProjectV2.Service
            const resolved = yield* project.resolve(location.directory)
            return yield* ProjectRegistry.register({
              id: resolved.id,
              previous: resolved.previous === resolved.id ? undefined : resolved.previous,
              directory: resolved.directory,
              vcs: resolved.vcs,
            }).pipe(Effect.provideContext(registry))
          }),
        ),
      )
  }),
)
