import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

// These passthroughs use `Schema.Any`, not `Schema.Unknown`. Responses are
// encoded with the JSON codec, where `Unknown` is `Link(Json, passthrough)` and
// therefore rejects any `undefined` nested in the value — while the payloads
// here keep optional fields such as a model's `limit.input` present as
// `undefined` (see `@miao/schema/model`). `Any` passes them through and lets
// JSON serialization drop them, which is what the typed V1 routes do too.

// The merged config is served as a permissive object until the V2 config schema
// moves from Core into Schema so the protocol can reference it.
const Info = Schema.Record(Schema.String, Schema.Any)

// The legacy provider shape the TUI store still consumes. Keep it permissive
// until the V2 provider/model schemas move from Core into Schema, then tighten
// `providers` to the public provider info array.
const Providers = Schema.Struct({
  providers: Schema.Array(Schema.Any),
  default: Schema.Record(Schema.String, Schema.String),
})

// The full provider catalog in the legacy V1 shape the TUI store consumes.
// Keep it permissive until the V2 provider/model schemas move from Core into
// Schema, then tighten `all` to the public provider info array.
const Catalog = Schema.Struct({
  all: Schema.Array(Schema.Any),
  default: Schema.Record(Schema.String, Schema.String),
  connected: Schema.Array(Schema.String),
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
  .add(
    HttpApiEndpoint.get("config.catalog", "/api/config/catalog", {
      query: LocationQuery,
      success: Location.response(Catalog),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.catalog",
          summary: "List provider catalog",
          description: "Retrieve the full provider catalog and its default models for the requested location.",
        }),
      ),
  )
