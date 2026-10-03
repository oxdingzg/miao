import { Location } from "@miao/schema/location"
import { MCP } from "@miao/schema/mcp"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export class McpServerNotFoundError extends Schema.TaggedErrorClass<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  { server: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const McpGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.status", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, MCP.Status)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.status",
          summary: "Get MCP status",
          description: "Get the status of every configured Model Context Protocol (MCP) server.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:name/connect", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: Location.response(Schema.Boolean),
      error: McpServerNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.connect",
          summary: "Connect MCP server",
          description: "Connect a Model Context Protocol (MCP) server.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:name/disconnect", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: Location.response(Schema.Boolean),
      error: McpServerNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.disconnect",
          summary: "Disconnect MCP server",
          description: "Disconnect a Model Context Protocol (MCP) server.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.authenticate", "/api/mcp/:name/auth", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: Location.response(MCP.Status),
      error: [McpServerNotFoundError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.authenticate",
          summary: "Authenticate MCP server",
          description:
            "Run the OAuth flow for a remote Model Context Protocol (MCP) server: opens a browser on the server host, waits for the authorization callback, stores the tokens, and reconnects. Responds with the resulting status.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("mcp.logout", "/api/mcp/:name/auth", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: Location.response(MCP.Status),
      error: McpServerNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.logout",
          summary: "Remove MCP credentials",
          description:
            "Forget the stored OAuth credentials of a Model Context Protocol (MCP) server and reconnect it without them.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("mcp.resources", "/api/mcp/resources", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, MCP.Resource)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.resources",
          summary: "Get MCP resources",
          description: "Get all available MCP resources from connected Model Context Protocol (MCP) servers.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "mcp", description: "MCP server management routes." }))
