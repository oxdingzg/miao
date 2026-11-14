import { describe, expect } from "bun:test"
import { createServer } from "node:net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AgentV2 } from "@miao/core/agent"
import { Config } from "@miao/core/config"
import { ConfigMCP } from "@miao/core/config/mcp"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { MCP } from "@miao/core/mcp"
import { McpAuth } from "@miao/core/mcp/auth"
import { McpBrowser } from "@miao/core/mcp/browser"
import { McpOAuthCallback } from "@miao/core/mcp/oauth-callback"
import { PermissionV2 } from "@miao/core/permission"
import { PermissionSaved } from "@miao/core/permission/saved"
import { AbsolutePath } from "@miao/core/schema"
import { SessionStore } from "@miao/core/session/store"
import { ToolRegistry } from "@miao/core/tool/registry"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// A browser that approves at once: it follows the authorization URL straight to the callback.
const approvingBrowser = Layer.succeed(
  McpBrowser.Service,
  McpBrowser.Service.of({
    open: (url) =>
      Effect.promise(async () => {
        const authorize = new URL(url)
        const callback = new URL(authorize.searchParams.get("redirect_uri")!)
        callback.searchParams.set("code", "valid-code")
        callback.searchParams.set("state", authorize.searchParams.get("state")!)
        await fetch(callback)
      }),
  }),
)

const build = (servers: Record<string, ConfigMCP.Local | ConfigMCP.Remote>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      MCP.node,
      McpAuth.node,
      ToolRegistry.toolsNode,
    ]),
    [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ mcp: new ConfigMCP.Info({ servers }) }),
                }),
              ]),
          }),
        ),
      ],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ],
      [McpBrowser.node, approvingBrowser],
    ],
  )

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

// A Streamable HTTP MCP server behind OAuth: it accepts only `Bearer granted-token`, which its
// token endpoint issues for the code `valid-code`.
const serveOAuthMcp = Effect.acquireRelease(
  Effect.promise(async () => {
    const protocol = new Server({ name: "oauth-mcp", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({ tools: [{ name: "probe", inputSchema: { type: "object" } }] }),
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const origin = url.origin
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
        if (url.pathname === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          })
        if (url.pathname === "/register")
          return Response.json({ ...((await request.json()) as object), client_id: "test-client" }, { status: 201 })
        if (url.pathname === "/token") {
          const body = new URLSearchParams(await request.text())
          if (body.get("code") !== "valid-code") return Response.json({ error: "invalid_grant" }, { status: 400 })
          return Response.json({ access_token: "granted-token", token_type: "Bearer" })
        }
        if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
        if (request.method === "GET") return new Response(null, { status: 405 })
        if (request.headers.get("authorization") !== "Bearer granted-token")
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            },
          })
        return transport.handleRequest(request)
      },
    })
    return {
      url: new URL("/mcp", http.url).toString(),
      close: async () => {
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

const remote = (url: string, port: number) =>
  new ConfigMCP.Remote({
    type: "remote",
    url,
    oauth: new ConfigMCP.OAuth({ redirect_uri: `http://127.0.0.1:${port}/mcp/oauth/callback` }),
  })

const stopCallback = Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

describe("MCP OAuth", () => {
  it.live("connects with tokens already stored for the server", () =>
    Effect.gen(function* () {
      const server = yield* serveOAuthMcp
      yield* McpAuth.Service.use((auth) =>
        auth.updateTokens("stored", { accessToken: "granted-token" }, server.url),
      ).pipe(Effect.provide(AppNodeBuilder.build(McpAuth.node)))

      const status = yield* MCP.Service.use((mcp) => mcp.status()).pipe(
        Effect.provide(build({ stored: remote(server.url, yield* Effect.promise(freePort)) })),
      )

      expect(status.stored).toEqual({ status: "connected" })
    }),
  )

  it.live("authenticates through the browser, stores the token, and reconnects", () =>
    Effect.gen(function* () {
      yield* stopCallback
      const server = yield* serveOAuthMcp
      const port = yield* Effect.promise(freePort)
      yield* Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).flow).toEqual({ status: "needs_auth" })

        expect(yield* mcp.authenticate("flow")).toEqual({ status: "connected" })
        expect((yield* mcp.status()).flow).toEqual({ status: "connected" })
        const stored = yield* McpAuth.Service.use((auth) => auth.getForUrl("flow", server.url))
        expect(stored?.tokens?.accessToken).toBe("granted-token")

        expect(yield* mcp.removeAuth("flow")).toEqual({ status: "needs_auth" })
        // Reconnecting without tokens may register the client again; only the tokens must be gone.
        expect((yield* McpAuth.Service.use((auth) => auth.get("flow")))?.tokens).toBeUndefined()
      }).pipe(Effect.provide(build({ flow: remote(server.url, port) })))
    }),
  )

  it.live("refuses local servers and unknown names", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const local = yield* mcp.authenticate("local").pipe(Effect.exit)
      expect(Exit.isFailure(local) && JSON.stringify(local.cause)).toContain("MCP.UnsupportedOAuthError")
      const missing = yield* mcp.authenticate("missing").pipe(Effect.exit)
      expect(Exit.isFailure(missing) && JSON.stringify(missing.cause)).toContain("MCP.NotFoundError")
    }).pipe(
      Effect.provide(build({ local: new ConfigMCP.Local({ type: "local", command: ["true"], disabled: true }) })),
    ),
  )
})
