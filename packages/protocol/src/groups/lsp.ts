import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const Status = Schema.Struct({
  id: Schema.String,
  extensions: Schema.Array(Schema.String),
  connected: Schema.Boolean,
})

export const LspGroup = HttpApiGroup.make("server.lsp").add(
  HttpApiEndpoint.get("lsp.status", "/api/lsp", {
    query: LocationQuery,
    success: Location.response(Schema.Array(Status)),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.lsp.status",
        summary: "Get LSP status",
        description: "List the language servers configured for the location and whether each is connected.",
      }),
    ),
)
