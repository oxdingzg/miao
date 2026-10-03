import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const WorktreeInfo = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree.Info" })

const DirectoryPayload = Schema.Struct({ directory: Schema.String })

export const WorktreeGroup = HttpApiGroup.make("server.worktree")
  .add(
    HttpApiEndpoint.post("worktree.create", "/api/worktree", {
      query: LocationQuery,
      payload: Schema.Struct({
        name: Schema.optional(Schema.String),
        startCommand: Schema.optional(Schema.String),
      }),
      success: Location.response(WorktreeInfo),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.create",
          summary: "Create worktree",
          description:
            "Create a git worktree of the requested location's project on a new `miao/<name>` branch. Returns at once; `worktree.ready` or `worktree.failed` follows for the new directory, then the project's start command runs there.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("worktree.remove", "/api/worktree", {
      query: LocationQuery,
      payload: DirectoryPayload,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.remove",
          summary: "Remove worktree",
          description: "Remove a git worktree of the requested location's project, its directory, and its branch.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("worktree.reset", "/api/worktree/reset", {
      query: LocationQuery,
      payload: DirectoryPayload,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.reset",
          summary: "Reset worktree",
          description:
            "Reset a secondary git worktree to the project's default branch, discarding every local change, then rerun the start command.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "worktree", description: "Git worktrees of a project." }))
