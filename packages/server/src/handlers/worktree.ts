import { Location } from "@miao/core/location"
import { LocationServiceMap } from "@miao/core/location-service-map"
import { ProjectWorktree } from "@miao/core/project/worktree"
import { AbsolutePath } from "@miao/core/schema"
import { InvalidRequestError } from "@miao/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const target = Effect.gen(function* () {
  const location = yield* Location.Service
  return { projectID: location.project.id, checkout: location.project.directory, git: location.vcs !== undefined }
})

const invalid = (error: ProjectWorktree.WorktreeError) =>
  new InvalidRequestError({ message: error.message, kind: "Worktree" })

export const WorktreeHandler = HttpApiBuilder.group(Api, "server.worktree", (handlers) =>
  Effect.gen(function* () {
    const worktrees = yield* ProjectWorktree.Service
    const locations = yield* LocationServiceMap.Service
    // Release the worktree's own location first, so its watchers and processes let go of the directory.
    const release = (directory: string) => locations.invalidate({ directory: AbsolutePath.make(directory) })
    return handlers
      .handle("worktree.create", (ctx) =>
        response(
          target.pipe(
            Effect.flatMap((value) => worktrees.create(value, ctx.payload)),
            Effect.mapError(invalid),
          ),
        ),
      )
      .handle("worktree.remove", (ctx) =>
        response(
          release(ctx.payload.directory).pipe(
            Effect.andThen(target),
            Effect.flatMap((value) => worktrees.remove(value, ctx.payload)),
            Effect.mapError(invalid),
          ),
        ),
      )
      .handle("worktree.reset", (ctx) =>
        response(
          release(ctx.payload.directory).pipe(
            Effect.andThen(target),
            Effect.flatMap((value) => worktrees.reset(value, ctx.payload)),
            Effect.mapError(invalid),
          ),
        ),
      )
  }),
)
