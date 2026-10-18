import { createHash } from "node:crypto"
import { McpAuth } from "@miao/core/mcp/auth"
import { oauthFetch } from "@miao/core/mcp/oauth-fetch"
import { Effect } from "effect"
import type { EngineOptions } from "./client"
import { EngineError } from "./client"

/** Native HTTP transport borrows the product's access-token authority. Refresh
 * grants stay in the product store and never enter native temporary manifests. */
export const prepare = Effect.fn("Engine.productMcp")(function* (
  options: Pick<EngineOptions, "mcpConfigFile" | "mcpSettings" | "policyFile">,
) {
  if (options.mcpConfigFile || !options.mcpSettings?.servers || !options.policyFile) return {}
  const policy: unknown = yield* Effect.tryPromise({
    try: () => Bun.file(options.policyFile!).json(),
    catch: () => new EngineError("engine_mcp_policy", "could not read native MCP policy"),
  })
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("mode" in policy) ||
    policy.mode !== "workspace" ||
    !("allow_mcp" in policy) ||
    policy.allow_mcp !== true
  )
    return {}
  const remotes = Object.entries(options.mcpSettings.servers).filter(
    (entry) => entry[1].type === "remote" && !entry[1].disabled && entry[1].oauth !== false,
  )
  if (!remotes.length) return {}
  const store = yield* McpAuth.Service
  const secret: string = crypto.randomUUID()
  const routes = new Map(
    remotes.flatMap(([name, remote]) => {
      if (remote.type !== "remote") return []
      const config = remote.oauth === false ? undefined : remote.oauth
      return [
        [
          `/${secret}/${encodeURIComponent(name)}` as string,
          {
            remote,
            fetch: oauthFetch(
              name,
              remote.url,
              {
                clientId: config?.client_id,
                clientSecret: config?.client_secret,
                scope: config?.scope,
                callbackPort: config?.callback_port,
                redirectUri: config?.redirect_uri,
              },
              store,
            ),
          },
        ] as const,
      ]
    }),
  )
  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          maxRequestBodySize: 16 * 1024 * 1024,
          idleTimeout: 0,
          async fetch(request) {
            const route = routes.get(new URL(request.url).pathname)
            if (!route || !["GET", "POST", "DELETE"].includes(request.method))
              return new Response(null, { status: 404 })
            const headers = new Headers(request.headers)
            for (const name of ["host", "connection", "authorization", "content-length"]) headers.delete(name)
            for (const [name, value] of Object.entries(route.remote.headers ?? {})) headers.set(name, value)
            return route
              .fetch(route.remote.url, {
                method: request.method,
                headers,
                ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
                signal: request.signal,
              })
              .catch(() => new Response("MCP OAuth authorization required", { status: 401 }))
          },
        }),
      catch: () => new EngineError("engine_mcp_authority", "could not start native MCP token routing"),
    }),
    (server) => Effect.promise(() => server.stop(true)),
  )
  return {
    mcpAuthorityRevisions: Object.fromEntries(
      remotes.map(([name, remote]) => [
        name,
        createHash("sha256").update(JSON.stringify({ name, remote })).digest("hex"),
      ]),
    ),
    mcpSettings: {
      ...options.mcpSettings,
      servers: Object.fromEntries(
        Object.entries(options.mcpSettings.servers).map(([name, remote]) => [
          name,
          remote.type === "remote" && !remote.disabled && remote.oauth !== false
            ? {
                ...remote,
                url: `${server.url}${secret}/${encodeURIComponent(name)}`,
                headers: {},
                oauth: false as const,
              }
            : remote,
        ]),
      ),
    },
  }
})

export * as ProductMcp from "./product-mcp"
