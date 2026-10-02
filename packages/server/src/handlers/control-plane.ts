import { MoveSession } from "@miao/core/control-plane/move-session"
import { SessionV2 } from "@miao/core/session"
import { ControlPlaneError } from "@miao/protocol/groups/control-plane"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ControlPlaneHandler = HttpApiBuilder.group(Api, "server.controlPlane", (handlers) =>
  handlers.handle("controlPlane.moveSession", (ctx) =>
    response(
      Effect.gen(function* () {
        const move = yield* MoveSession.Service
        yield* move.moveSession(ctx.payload).pipe(
          Effect.mapError(
            (error) =>
              new ControlPlaneError({
                name: "ControlPlaneError",
                data: { message: message(error) },
              }),
          ),
        )
        return undefined
      }),
    ),
  ),
)

function message(error: MoveSession.Error) {
  if (error instanceof SessionV2.NotFoundError) return `Session not found: ${error.sessionID}`
  if (error instanceof MoveSession.DestinationProjectMismatchError)
    return "Destination directory belongs to another project"
  if (error instanceof MoveSession.ApplyChangesError)
    return `Unable to apply your changes in the destination directory. The files may conflict with existing changes.`
  return error.message
}
