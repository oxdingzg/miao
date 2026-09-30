import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  handlers
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
    ),
)
