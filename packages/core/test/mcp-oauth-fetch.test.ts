import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { McpAuth } from "@miao/core/mcp/auth"
import { oauthFetch } from "@miao/core/mcp/oauth-fetch"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(McpAuth.node))

it.live("OAuth consumers serialize rotating grants and reuse persisted tokens after reconnect", () =>
  Effect.gen(function* () {
    const store = yield* McpAuth.Service
    const name = `rotation-${crypto.randomUUID()}`
    const state = { rotations: 0, refresh: "refresh-0", access: "access-0", reject: false, replaceDuringRefresh: false }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        if (url.pathname.includes(".well-known/oauth-protected-resource"))
          return Response.json({ resource: `${server.url}mcp`, authorization_servers: [server.url.toString()] })
        if (url.pathname.includes(".well-known/"))
          return Response.json({
            issuer: server.url.toString(),
            authorization_endpoint: `${server.url}authorize`,
            token_endpoint: `${server.url}token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          })
        if (url.pathname === "/token") {
          const form = new URLSearchParams(await request.text())
          if (state.reject || form.get("refresh_token") !== state.refresh)
            return Response.json(
              { error: "invalid_grant", error_description: "private-provider-secret" },
              { status: 400 },
            )
          await Bun.sleep(20)
          state.rotations++
          state.refresh = `refresh-${state.rotations}`
          state.access = `access-${state.rotations}`
          if (state.replaceDuringRefresh)
            await Effect.runPromise(
              store.set(
                name,
                { tokens: { accessToken: "replacement-access", refreshToken: "replacement-refresh" } },
                `${server.url}other`,
              ),
            )
          return Response.json({
            access_token: state.access,
            refresh_token: state.refresh,
            token_type: "Bearer",
            expires_in: 3600,
          })
        }
        if (request.headers.get("authorization") !== `Bearer ${state.access}`)
          return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
        return new Response((await request.text()) || "ok")
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
    yield* Effect.addFinalizer(() => store.remove(name))
    const url = `${server.url}mcp`
    yield* store.set(
      name,
      {
        tokens: { accessToken: "expired", refreshToken: state.refresh, expiresAt: 0 },
      },
      url,
    )
    const first = oauthFetch(name, url, { clientId: "fixture" }, store)
    const second = oauthFetch(name, url, { clientId: "fixture" }, store)
    const responses = yield* Effect.promise(() =>
      Promise.all([first(url, { method: "POST", body: "one" }), second(url, { method: "POST", body: "two" })]),
    )
    expect(yield* Effect.promise(() => Promise.all(responses.map((response) => response.text())))).toEqual([
      "one",
      "two",
    ])
    expect(state.rotations).toBe(1)
    expect((yield* store.getForUrl(name, url))?.tokens?.refreshToken).toBe("refresh-1")
    const restarted = oauthFetch(name, url, { clientId: "fixture" }, store)
    expect((yield* Effect.promise(() => restarted(url))).status).toBe(200)
    expect(state.rotations).toBe(1)
    // The server revokes the unexpired access token: concurrent 401s still
    // refresh the observed generation once, without losing request bodies.
    state.access = "revoked"
    const retried = yield* Effect.promise(() =>
      Promise.all([first(url, { method: "POST", body: "three" }), second(url, { method: "POST", body: "four" })]),
    )
    expect(yield* Effect.promise(() => Promise.all(retried.map((response) => response.text())))).toEqual([
      "three",
      "four",
    ])
    expect(state.rotations).toBe(2)
    state.reject = true
    state.access = "revoked-again"
    const failure = yield* Effect.promise(() =>
      restarted(url).then(
        () => "unexpected",
        (error: Error) => error.message,
      ),
    )
    expect(failure).toBe("MCP OAuth authorization required")
    expect(failure).not.toContain("private-provider-secret")
    const changed = oauthFetch(name, `${server.url}changed`, { clientId: "fixture" }, store)
    expect(
      yield* Effect.promise(() =>
        changed(`${server.url}changed`).then(
          () => "unexpected",
          (error: Error) => error.message,
        ),
      ),
    ).toBe("MCP OAuth authorization required")
    state.reject = false
    state.replaceDuringRefresh = true
    yield* store.updateTokens(name, { accessToken: "expired-again", refreshToken: state.refresh, expiresAt: 0 }, url)
    expect(
      yield* Effect.promise(() =>
        restarted(url).then(
          () => "unexpected",
          (error: Error) => error.message,
        ),
      ),
    ).toBe("MCP OAuth authorization required")
    const replaced = yield* store.get(name)
    expect(replaced?.serverUrl).toBe(`${server.url}other`)
    expect(replaced?.tokens?.refreshToken).toBe("replacement-refresh")
  }),
)
