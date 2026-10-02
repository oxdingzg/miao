import { MoveSession } from "@miao/core/control-plane/move-session"
import { SessionV2 } from "@miao/core/session"
import { ControlPlaneError } from "@miao/protocol/groups/control-plane"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ControlPlaneHandler = HttpApiBuilder.group(Api, "server.controlPlane", (handlers) =>
  // MoveSession is a stable app-level service, not a location service: yield it
  // once here. Yielding it inside the handler would make it a request-level
  // requirement of the location middleware, which only provides location
  // services and so can never satisfy it.
  Effect.gen(function* () {
    const move = yield* MoveSession.Service
    return handlers.handle("controlPlane.moveSession", (ctx) =>
      response(
        move.moveSession(ctx.payload).pipe(
          Effect.mapError(
            (error) =>
              new ControlPlaneError({
                name: "ControlPlaneError",
                data: { message: message(error) },
              }),
          ),
          Effect.as(undefined),
        ),
      ),
    )
  }),
)

function message(error: MoveSession.Error) {
  if (error instanceof SessionV2.NotFoundError) return `Session not found: ${error.sessionID}`
  if (error instanceof MoveSession.DestinationProjectMismatchError)
    return "Destination directory belongs to another project"
  if (error instanceof MoveSession.ApplyChangesError)
    return `Unable to apply your changes in the destination directory. The files may conflict with existing changes.`
  return error.message
}
