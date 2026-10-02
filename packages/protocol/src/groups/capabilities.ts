import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const CapabilitiesGroup = HttpApiGroup.make("server.capabilities").add(
  HttpApiEndpoint.get("capabilities.get", "/api/capabilities", {
    query: LocationQuery,
    success: Location.response(Schema.Struct({ backgroundSubagents: Schema.Boolean })),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.capabilities.get",
        summary: "Get server capabilities",
        description: "Retrieve server capabilities for the requested location.",
      }),
    ),
)
