import { expect } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { McpAuth } from "@miao/core/mcp/auth"
import { oauthFetch } from "@miao/core/mcp/oauth-fetch"
import { ConfigMCP } from "@miao/schema/config/mcp"
import { Effect, Schema } from "effect"
import { ProductMcp } from "../../src/engine/product-mcp"
import { prepareMcpConfig } from "../../src/engine/mcp-config"
import { EngineClient } from "../../src/engine/client"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(McpAuth.node))

it.live("native MCP and SDK consumers share rotating OAuth authority without copying grants", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const store = yield* McpAuth.Service
    const name = `native_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const state = { rotations: 0, initialized: 0, listed: 0 }
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        if (url.pathname.includes(".well-known/oauth-protected-resource"))
          return Response.json({ resource: `${upstream.url}mcp`, authorization_servers: [upstream.url.toString()] })
        if (url.pathname.includes(".well-known/"))
          return Response.json({
            issuer: upstream.url.toString(),
            authorization_endpoint: `${upstream.url}authorize`,
            token_endpoint: `${upstream.url}token`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          })
        if (url.pathname === "/token") {
          const body = new URLSearchParams(await request.text())
          if (body.get("refresh_token") !== `private-refresh-${state.rotations}`)
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          await Bun.sleep(20)
          state.rotations++
          return Response.json({
            access_token: `private-access-${state.rotations}`,
            refresh_token: `private-refresh-${state.rotations}`,
            expires_in: 3600,
            token_type: "Bearer",
          })
        }
        if (request.headers.get("authorization") !== `Bearer private-access-${state.rotations}`)
          return new Response(null, { status: 401 })
        if (url.pathname === "/probe") return new Response("ok")
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const body = await request.json()
        if (body.id === undefined) return new Response(null, { status: 202 })
        if (body.method === "initialize") {
          state.initialized++
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-fixture", version: "1" },
            },
          })
        }
        if (body.method === "tools/list") {
          state.listed++
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} })
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => upstream.stop(true)))
    yield* Effect.addFinalizer(() => store.remove(name))
    const url = `${upstream.url}mcp`
    yield* store.set(name, { tokens: { accessToken: "expired", refreshToken: "private-refresh-0", expiresAt: 0 } }, url)
    const policyFile = path.join(tmp.path, "policy.json")
    yield* Effect.promise(() => Bun.write(policyFile, JSON.stringify({ mode: "workspace", allow_mcp: true })))
    const options = {
      binary: process.env.MIAO_ENGINE_BIN ?? "unused",
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      policyFile,
      mcpSettings: Schema.decodeUnknownSync(ConfigMCP.Info)({
        servers: { [name]: { type: "remote", url, oauth: { client_id: "fixture" } } },
      }),
    }
    const prepared = yield* ProductMcp.prepare(options)
    const snapshot = prepareMcpConfig({ ...options, ...prepared })
    if (!snapshot) throw new Error("native OAuth attachment missing")
    yield* Effect.addFinalizer(() => Effect.sync(snapshot.dispose))
    const manifest = yield* Effect.promise(() => Bun.file(snapshot.file).text())
    expect(manifest).not.toContain("private-refresh")
    expect(manifest).not.toContain("private-access")
    expect(manifest).not.toContain("client_id")
    const remote = prepared.mcpSettings?.servers[name]
    if (remote?.type !== "remote") throw new Error("native OAuth routing missing")
    const sdk = oauthFetch(name, url, { clientId: "fixture" }, store)
    const requests = [
      sdk(`${upstream.url}probe`),
      fetch(remote.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
    ]
    const responses = yield* Effect.promise(() => Promise.all(requests))
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(state.rotations).toBe(1)
    if (process.env.MIAO_ENGINE_BIN) {
      const client = EngineClient.start({
        ...options,
        mcpSettings: undefined,
        mcpConfigFile: snapshot.file,
        env: { ANTHROPIC_API_KEY: "fixture" },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
      yield* Effect.promise(() =>
        client.request("initialize", { session_id: "native_oauth_probe", title: "OAuth probe" }),
      )
      expect(state.initialized).toBe(1)
      expect(state.listed).toBeGreaterThanOrEqual(2)
      expect(state.rotations).toBe(1)
    }
    expect((yield* store.getForUrl(name, url))?.tokens?.refreshToken).toBe("private-refresh-1")
  }),
)
