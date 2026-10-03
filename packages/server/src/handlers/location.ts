import { Global } from "@miao/core/global"
import { Location } from "@miao/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    return handlers
      .handle(
        "location.get",
        Effect.fn(function* () {
          const location = yield* Location.Service
          return new Location.Info({
            directory: location.directory,
            workspaceID: location.workspaceID,
            project: location.project,
          })
        }),
      )
      .handle(
        "location.path",
        Effect.fn(function* () {
          const location = yield* Location.Service
          return {
            home: global.home,
            state: global.state,
            config: global.config,
            worktree: location.vcs ? location.project.directory : "/",
            directory: location.directory,
          }
        }),
      )
  }),
)
