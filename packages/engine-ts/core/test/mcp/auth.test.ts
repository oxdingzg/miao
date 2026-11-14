import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { FSUtil } from "@miao/core/fs-util"
import { McpAuth } from "@miao/core/mcp/auth"

function authFile() {
  let raw = ""
  let activeWrites = 0
  let sawOverlap = false

  const fsLayer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return FSUtil.Service.of({
        ...fs,
        readJson: (file) =>
          file.endsWith("mcp-auth.json")
            ? Effect.try({
                try: () => {
                  if (!raw) throw new Error("mcp-auth.json missing")
                  return JSON.parse(raw)
                },
                catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
              })
            : fs.readJson(file),
        writeJson: (file, value, mode) =>
          file.endsWith("mcp-auth.json")
            ? Effect.promise(async () => {
                activeWrites++
                sawOverlap = sawOverlap || activeWrites > 1
                raw = ""
                await sleep(10)
                const next = JSON.stringify(value, null, 2)
                raw = sawOverlap ? `${next}\n}` : next
                activeWrites--
              })
            : fs.writeJson(file, value, mode),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))

  return { fsLayer, raw: () => raw }
}

function authService(fsLayer: Layer.Layer<FSUtil.Service>) {
  return McpAuth.Service.use((auth) => Effect.succeed(auth)).pipe(
    Effect.provide(AppNodeBuilder.build(McpAuth.node, [[FSUtil.node, fsLayer]])),
  )
}

test("serializes concurrent auth file updates across service instances", async () => {
  const file = authFile()

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* authService(file.fsLayer)
      const second = yield* authService(file.fsLayer)

      yield* Effect.all(
        [
          first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
          second.updateClientInfo("posthog", { clientId: "client-id" }, "https://mcp.posthog.com/mcp"),
        ],
        { concurrency: "unbounded" },
      )

      const entry = yield* first.get("posthog")
      expect(entry?.tokens?.accessToken).toBe("access-token")
      expect(entry?.clientInfo?.clientId).toBe("client-id")
      expect(entry?.serverUrl).toBe("https://mcp.posthog.com/mcp")
      expect(() => JSON.parse(file.raw())).not.toThrow()
    }),
  )
})

test("preserves omitted refresh tokens and commits explicit rotations for the exact server URL", async () => {
  const file = authFile()
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.fsLayer)
      const url = "https://mcp.example.test/one"
      yield* auth.updateTokens("fixture", { accessToken: "access-one", refreshToken: "refresh-one" }, url)
      yield* auth.updateTokens("fixture", { accessToken: "access-two" }, url)
      expect((yield* auth.getForUrl("fixture", url))?.tokens).toMatchObject({
        accessToken: "access-two",
        refreshToken: "refresh-one",
      })
      yield* auth.updateTokens("fixture", { accessToken: "access-three", refreshToken: "refresh-two" }, url)
      const reopened = yield* authService(file.fsLayer)
      expect((yield* reopened.getForUrl("fixture", url))?.tokens).toMatchObject({
        accessToken: "access-three",
        refreshToken: "refresh-two",
      })
      yield* reopened.updateTokens("fixture", { accessToken: "access-four" }, "https://mcp.example.test/two")
      expect(yield* reopened.getForUrl("fixture", url)).toBeUndefined()
      expect(
        (yield* reopened.getForUrl("fixture", "https://mcp.example.test/two"))?.tokens?.refreshToken,
      ).toBeUndefined()
    }),
  )
})

test("changing a server URL through client registration cannot rebind old tokens or authorization state", async () => {
  const file = authFile()
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.fsLayer)
      yield* auth.set(
        "fixture",
        {
          tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
          clientInfo: { clientId: "old-client", clientSecret: "old-secret" },
          codeVerifier: "old-verifier",
          oauthState: "old-state",
        },
        "https://mcp.example.test/old",
      )
      yield* auth.updateClientInfo("fixture", { clientId: "new-client" }, "https://mcp.example.test/new")
      expect(yield* auth.getForUrl("fixture", "https://mcp.example.test/new")).toEqual({
        clientInfo: { clientId: "new-client" },
        serverUrl: "https://mcp.example.test/new",
      })
      expect(yield* auth.getForUrl("fixture", "https://mcp.example.test/old")).toBeUndefined()
    }),
  )
})

test("issuer-keyed grants: adopt, fan-out and freshest lookup", async () => {
  const file = authFile()
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.fsLayer)
      const issuer = "https://as.example.test/"
      const fresh = (accessToken: string, expiresIn: number) => ({
        accessToken,
        refreshToken: `${accessToken}-refresh`,
        expiresAt: Date.now() / 1000 + expiresIn,
      })
      yield* auth.set(
        "posthog",
        {
          tokens: fresh("as-one", 3600),
          clientInfo: { clientId: "shared-client" },
          issuer,
        },
        "https://mcp.posthog.com/mcp",
      )

      expect(Object.keys(yield* auth.findByIssuer(issuer))).toEqual(["posthog"])

      // Adoption copies the grant and binds the adopting server's URL.
      const donor = (yield* auth.getForUrl("posthog", "https://mcp.posthog.com/mcp"))!
      expect(
        yield* auth.adopt("linear", "https://mcp.linear.app/mcp", { name: "posthog", entry: donor }),
      ).toBe(true)
      const adopted = yield* auth.getForUrl("linear", "https://mcp.linear.app/mcp")
      expect(adopted?.tokens?.accessToken).toBe("as-one")
      expect(adopted?.issuer).toBe(issuer)
      // The dynamically registered client rides along, so the adopting
      // server reuses it instead of registering again.
      expect(adopted?.clientInfo).toEqual({ clientId: "shared-client" })
      expect(Object.keys(yield* auth.findByIssuer(issuer))).toEqual(["posthog", "linear"])

      // A stale donor view adopts nothing.
      expect(
        yield* auth.adopt("other", "https://mcp.other.test/mcp", {
          name: "posthog",
          entry: { ...donor, tokens: fresh("stale", 3600) },
        }),
      ).toBe(false)

      // Rotation fans out to every sharer except the rotator, keeping
      // per-entry refresh fallbacks (refresh responses may omit an unchanged
      // refresh token), and never touches entries behind a different issuer.
      yield* auth.updateTokens("linear", { accessToken: "as-two", refreshToken: "as-two-refresh" })
      yield* auth.updateTokens("unrelated", { accessToken: "other-issuer" }, "https://mcp.other.test/mcp")
      yield* auth.updateTokensForIssuer(issuer, "linear", {
        accessToken: "as-three",
        expiresAt: Date.now() / 1000 + 7200,
      })
      expect((yield* auth.getForUrl("linear", "https://mcp.linear.app/mcp"))?.tokens?.accessToken).toBe("as-two")
      expect((yield* auth.getForUrl("linear", "https://mcp.linear.app/mcp"))?.tokens?.refreshToken).toBe(
        "as-two-refresh",
      )
      expect((yield* auth.getForUrl("posthog", "https://mcp.posthog.com/mcp"))?.tokens?.accessToken).toBe("as-three")
      expect((yield* auth.getForUrl("posthog", "https://mcp.posthog.com/mcp"))?.tokens?.refreshToken).toBe(
        "as-one-refresh",
      )
      expect((yield* auth.get("unrelated"))?.tokens?.accessToken).toBe("other-issuer")

      // The freshest sharer's tokens win; expired and excluded entries do not.
      yield* auth.updateTokens("posthog", fresh("stale-sharer", -10))
      expect(yield* auth.freshFromIssuer(issuer, undefined)).toMatchObject({ accessToken: "as-two" })
      expect(yield* auth.freshFromIssuer(issuer, "linear")).toBeUndefined()
    }),
  )
})
