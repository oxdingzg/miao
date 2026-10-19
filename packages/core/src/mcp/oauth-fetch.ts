import { auth, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Effect } from "effect"
import { McpAuth, type Entry } from "./auth"
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { McpOAuthProvider, type McpOAuthConfig } from "./oauth-provider"

/** One refresh authority for SDK transports and native host routing. The lock
 * covers re-read, network exchange and durable rotation, across processes. */
export function oauthFetch(
  name: string,
  serverUrl: string,
  config: McpOAuthConfig,
  store: McpAuth.Interface,
): FetchLike {
  const current = () => Effect.runPromise(store.getForUrl(name, serverUrl))
  const refresh = (observed: string | undefined, challenge?: Response) =>
    Effect.runPromise(
      store.withRefreshLock(
        name,
        serverUrl,
        Effect.tryPromise(async () => {
          const entry = await current()
          // Another consumer may have rotated the exact grant while we waited.
          if (
            entry?.tokens &&
            entry.tokens.accessToken !== observed &&
            (entry.tokens.expiresAt === undefined || entry.tokens.expiresAt > Date.now() / 1000 + 30)
          )
            return entry.tokens.accessToken
          if (!entry?.tokens?.refreshToken) throw new UnauthorizedError("MCP OAuth authorization required")
          const provider = new RefreshProvider(name, serverUrl, config, store, entry)
          const signal = AbortSignal.timeout(30_000)
          const result = await auth(provider, {
            serverUrl,
            ...(challenge ? extractWWWAuthenticateParams(challenge) : {}),
            fetchFn: (input, init) => upstream(input, { ...init, signal }),
          })
          if (result !== "AUTHORIZED") throw new UnauthorizedError("MCP OAuth authorization required")
          const updated = await current()
          if (!updated?.tokens?.accessToken) throw new UnauthorizedError("MCP OAuth authorization required")
          return updated.tokens.accessToken
        }),
      ),
    ).catch(() => {
      // Provider bodies may contain credentials. Only a stable auth status
      // crosses the host boundary or reaches transport diagnostics.
      throw new UnauthorizedError("MCP OAuth authorization required")
    })

  const upstream: FetchLike = fetch
  return async (input, init) => {
    if (init?.body && typeof init.body === "object" && Symbol.asyncIterator in init.body)
      throw new Error("MCP OAuth requires a replayable request body")
    if (new URL(input).origin !== new URL(serverUrl).origin)
      throw new UnauthorizedError("MCP OAuth request origin changed")
    const entry = await current()
    const tokens = entry?.tokens
    const token =
      tokens?.expiresAt !== undefined && tokens.expiresAt <= Date.now() / 1000 + 30 && tokens.refreshToken
        ? await refresh(tokens.accessToken)
        : tokens?.accessToken
    const send = (token: string | undefined) => {
      const headers = new Headers(init?.headers)
      if (token) headers.set("Authorization", `Bearer ${token}`)
      return upstream(input, { ...init, headers })
    }
    const response = await send(token)
    if (response.status !== 401) return response
    const replacement = await refresh(token, response).finally(() => response.body?.cancel())
    return send(replacement)
  }
}

// SDK auth may otherwise invalidate credentials and fall through to browser
// authorization. A request-time refresh must never mutate a different grant
// generation, initiate login, or erase a concurrently replaced server binding.
class RefreshProvider extends McpOAuthProvider {
  constructor(
    name: string,
    url: string,
    config: McpOAuthConfig,
    store: McpAuth.Interface,
    private expected: Entry,
  ) {
    super(name, url, config, { onRedirect: async () => {} }, store)
  }

  override async saveTokens(tokens: OAuthTokens): Promise<void> {
    const accepted = await Effect.runPromise(
      this.auth.updateTokensIfCurrent(this.mcpName, this.serverUrl, this.expected, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in === undefined ? undefined : Date.now() / 1000 + tokens.expires_in,
        scope: tokens.scope,
      }),
    )
    if (!accepted) throw new UnauthorizedError("MCP OAuth grant changed during refresh")
  }

  override async invalidateCredentials(): Promise<void> {
    throw new UnauthorizedError("MCP OAuth authorization required")
  }
  override async saveClientInformation(): Promise<void> {
    throw new UnauthorizedError("MCP OAuth client registration required")
  }
  override async saveCodeVerifier(): Promise<void> {
    throw new UnauthorizedError("MCP OAuth authorization required")
  }
  override async state(): Promise<string> {
    return ""
  }
}
