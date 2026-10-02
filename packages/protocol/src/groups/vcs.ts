import { Location } from "@miao/schema/location"
import { Vcs } from "@miao/schema/vcs"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const VcsGroup = HttpApiGroup.make("server.vcs")
  .add(
    HttpApiEndpoint.get("vcs.get", "/api/vcs", {
      query: LocationQuery,
      success: Location.response(Vcs.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.get",
          summary: "Get VCS info",
          description: "Retrieve version control info such as the current branch for the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("vcs.status", "/api/vcs/status", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Vcs.FileStatus)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.status",
          summary: "Get VCS status",
          description: "Retrieve changed files in the working tree without patches for the requested location.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "vcs",
      description: "Experimental location-scoped version control routes.",
    }),
  )
