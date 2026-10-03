import { MCP } from "@miao/core/mcp"
import { InvalidRequestError } from "@miao/protocol/errors"
import { McpServerNotFoundError } from "@miao/protocol/groups/mcp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const notFound = (error: MCP.NotFoundError) =>
  new McpServerNotFoundError({ server: error.name, message: `MCP server not found: ${error.name}` })

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  handlers
    .handle(
      "mcp.status",
      Effect.fn(function* () {
        const mcp = yield* MCP.Service
        return yield* response(mcp.status())
      }),
    )
    .handle(
      "mcp.resources",
      Effect.fn(function* () {
        const mcp = yield* MCP.Service
        return yield* response(mcp.resources())
      }),
    )
    .handle(
      "mcp.authenticate",
      Effect.fn(function* (ctx) {
        const mcp = yield* MCP.Service
        return yield* response(
          mcp.authenticate(ctx.params.name).pipe(
            Effect.catchTag("MCP.NotFoundError", (error) => Effect.fail(notFound(error))),
            Effect.catchTag("MCP.UnsupportedOAuthError", (error) =>
              Effect.fail(
                new InvalidRequestError({ kind: "Mcp", message: `MCP server ${error.name} does not support OAuth` }),
              ),
            ),
          ),
        )
      }),
    )
    .handle(
      "mcp.logout",
      Effect.fn(function* (ctx) {
        const mcp = yield* MCP.Service
        return yield* response(
          mcp.removeAuth(ctx.params.name).pipe(Effect.catchTag("MCP.NotFoundError", (error) => Effect.fail(notFound(error)))),
        )
      }),
    )
    .handle(
      "mcp.connect",
      Effect.fn(function* (ctx) {
        const mcp = yield* MCP.Service
        yield* mcp.connect(ctx.params.name).pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ server: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
        return yield* response(Effect.succeed(true))
      }),
    )
    .handle(
      "mcp.disconnect",
      Effect.fn(function* (ctx) {
        const mcp = yield* MCP.Service
        yield* mcp.disconnect(ctx.params.name).pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ server: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
        return yield* response(Effect.succeed(true))
      }),
    ),
)
