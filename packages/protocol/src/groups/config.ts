import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

// The merged config is served as a permissive object until the V2 config schema
// moves from Core into Schema so the protocol can reference it.
const Info = Schema.Record(Schema.String, Schema.Unknown)

// The legacy provider shape the TUI store still consumes. Keep it permissive
// until the V2 provider/model schemas move from Core into Schema, then tighten
// `providers` to the public provider info array.
const Providers = Schema.Struct({
  providers: Schema.Array(Schema.Unknown),
  default: Schema.Record(Schema.String, Schema.String),
})

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Location.response(Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.get",
          summary: "Get config",
          description: "Retrieve the merged configuration for the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.providers", "/api/config/providers", {
      query: LocationQuery,
      success: Location.response(Providers),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.providers",
          summary: "List providers",
          description: "Retrieve available providers and their default models for the requested location.",
        }),
      ),
  )
