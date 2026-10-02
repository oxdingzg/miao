import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const Status = Schema.Struct({
  name: Schema.String,
  extensions: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
})

export const FormatterGroup = HttpApiGroup.make("server.formatter").add(
  HttpApiEndpoint.get("formatter.status", "/api/formatter", {
    query: LocationQuery,
    success: Location.response(Schema.Array(Status)),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.formatter.status",
        summary: "Get formatter status",
        description: "List the configured formatters and whether each one is available.",
      }),
    ),
)
