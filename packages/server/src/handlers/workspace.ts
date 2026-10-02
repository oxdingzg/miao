import { Location } from "@miao/core/location"
import { WorkspaceV2 } from "@miao/core/workspace"
import { InvalidRequestError } from "@miao/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const WorkspaceHandler = HttpApiBuilder.group(Api, "server.workspace", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceV2.Service

    const run = <A, E>(fn: (scope: WorkspaceV2.Scope) => Effect.Effect<A, E>) =>
      response(
        Effect.gen(function* () {
          const location = yield* Location.Service
          return yield* fn({ projectID: location.project.id, directory: location.directory })
        }),
      )

    const reject = Effect.mapError(
      (error: WorkspaceV2.UnsupportedError) => new InvalidRequestError({ message: error.message }),
    )

    return handlers
      .handle("workspace.list", () => run((scope) => workspace.list(scope)))
      .handle("workspace.status", () => run((scope) => workspace.status(scope)))
      .handle("workspace.adapters", () => run((scope) => workspace.adapters(scope)))
      .handle("workspace.create", (ctx) => run((scope) => workspace.create(ctx.payload, scope).pipe(reject)))
      .handle("workspace.syncList", () => run((scope) => workspace.syncList(scope).pipe(reject, Effect.as(true))))
      .handle("workspace.warp", (ctx) =>
        run((scope) => workspace.warp(ctx.payload, scope).pipe(reject, Effect.as(true))),
      )
      .handle("workspace.remove", (ctx) => run((scope) => workspace.remove(ctx.params.id, scope).pipe(reject)))
  }),
)
