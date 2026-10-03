import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { ProjectNotFoundError } from "@miao/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.gen(function* () {
    const metadata = yield* ProjectMetadata.Service
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
  }),
)
