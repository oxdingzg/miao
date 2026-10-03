import { Location } from "@miao/schema/location"
import { Project } from "@miao/schema/project"
import { AbsolutePath } from "@miao/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError, UnknownError } from "../errors"
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
    HttpApiEndpoint.get("project.list", "/api/project", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Project.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.list",
          summary: "List projects",
          description: "List every known project with its display metadata.",
        }),
      ),
  )
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
  .add(
    HttpApiEndpoint.patch("project.update", "/api/project/:projectID", {
      params: { projectID: Project.ID },
      query: LocationQuery,
      payload: Project.UpdateInput,
      success: Location.response(Project.Info),
      error: ProjectNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.update",
          summary: "Update project",
          description: "Update a project's name, icon, or workspace start command.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("project.initGit", "/api/project/git/init", {
      query: LocationQuery,
      success: Location.response(Project.Info),
      error: UnknownError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.initGit",
          summary: "Initialize git",
          description:
            "Create a git repository in the requested directory unless it is already in one, and return the project it now belongs to.",
        }),
      ),
  )
