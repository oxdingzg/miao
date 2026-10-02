import { Model } from "@miao/schema/model"
import { Location } from "@miao/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ModelGroup = HttpApiGroup.make("server.model")
  .add(
    HttpApiEndpoint.get("model.list", "/api/model", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Model.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.model.list",
          summary: "List models",
          description: "Retrieve available models ordered by release date.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("model.default", "/api/model/default", {
      query: LocationQuery,
      success: Location.response(Schema.NullOr(Model.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.model.default",
          summary: "Get default model",
          description:
            "Retrieve the model a session without an explicit model runs with: the configured default when it is available, otherwise the newest available model. Null when no model is available.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "models",
      description: "Experimental model routes.",
    }),
  )
