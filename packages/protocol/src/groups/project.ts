import { Location } from "@miao/schema/location"
import { Project } from "@miao/schema/project"
import { AbsolutePath } from "@miao/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ProjectCurrent = Schema.Struct({
  id: Project.ID,
  directory: AbsolutePath,
}).annotate({ identifier: "Project.Current" })

export const ProjectDirectory = Schema.Struct({
  directory: AbsolutePath,
  strategy: Schema.optional(Schema.String),
}).annotate({ identifier: "Project.Directory" })

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(
    HttpApiEndpoint.get("project.current", "/api/project/current", {
      query: LocationQuery,
      success: Location.response(ProjectCurrent),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.current",
          summary: "Get current project",
          description: "Resolve the project for the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("project.directories", "/api/project/:projectID/directories", {
      params: { projectID: Project.ID },
      query: LocationQuery,
      success: Location.response(Schema.Array(ProjectDirectory)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.directories",
          summary: "List project directories",
          description: "List the known directories for a project.",
        }),
      ),
  )
