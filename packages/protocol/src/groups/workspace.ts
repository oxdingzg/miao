import { Location } from "@miao/schema/location"
import { Workspace } from "@miao/schema/workspace"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const WorkspaceGroup = HttpApiGroup.make("server.workspace")
  .add(
    HttpApiEndpoint.get("workspace.list", "/api/workspace", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Workspace.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.list",
          summary: "List workspaces",
          description: "List the workspaces registered for the requested location's project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("workspace.status", "/api/workspace/status", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Workspace.ConnectionStatus)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.status",
          summary: "Workspace status",
          description: "Report the connection status of workspaces in the requested location's project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("workspace.adapters", "/api/workspace/adapter", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Workspace.AdapterEntry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.adapters",
          summary: "List workspace adapters",
          description: "List the workspace adapters available to the requested location's project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("workspace.create", "/api/workspace", {
      query: LocationQuery,
      payload: Workspace.CreateInput,
      success: Location.response(Workspace.Info),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.create",
          summary: "Create workspace",
          description: "Create a workspace for the requested location's project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("workspace.syncList", "/api/workspace/sync", {
      query: LocationQuery,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.syncList",
          summary: "Sync workspace list",
          description: "Register workspaces returned by the project's workspace adapters.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("workspace.warp", "/api/workspace/warp", {
      query: LocationQuery,
      payload: Workspace.WarpInput,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.warp",
          summary: "Warp session into workspace",
          description: "Move a session's sync history into a workspace, or detach it to the local project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("workspace.remove", "/api/workspace/:id", {
      params: { id: Workspace.ID },
      query: LocationQuery,
      success: Location.response(Schema.UndefinedOr(Workspace.Info)),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workspace.remove",
          summary: "Remove workspace",
          description: "Remove an existing workspace.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "workspace",
      description: "Location-scoped workspace routes.",
    }),
  )
