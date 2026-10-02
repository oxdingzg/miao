import { ControlPlane } from "@miao/schema/control-plane"
import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export class ControlPlaneError extends Schema.ErrorClass<ControlPlaneError>("ControlPlaneError")(
  {
    name: Schema.Literal("ControlPlaneError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

const MoveSessionPayload = Schema.Struct({ ...ControlPlane.MoveSessionInput.fields })

export const ControlPlaneGroup = HttpApiGroup.make("server.controlPlane")
  .add(
    HttpApiEndpoint.post("controlPlane.moveSession", "/api/control-plane/move-session", {
      query: LocationQuery,
      payload: MoveSessionPayload,
      success: Location.response(Schema.Undefined),
      error: ControlPlaneError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.controlPlane.moveSession",
          summary: "Move session",
          description: "Move a session to another project directory, optionally transferring local changes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "controlPlane",
      description: "Control-plane orchestration routes.",
    }),
  )
