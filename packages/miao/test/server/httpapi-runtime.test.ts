import { afterEach, describe, expect, test } from "bun:test"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { randomBytes } from "node:crypto"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app(password: string, runtime?: RuntimeIdentity.Interface) {
  const server = HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(undefined, runtime).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ MIAO_SERVER_PASSWORD: password }))),
    ),
    { disableLogger: true },
  )
  return {
    request: (route: string, init?: RequestInit) =>
      server.handler(new Request(`http://localhost${route}`, init), HttpApiApp.context),
    dispose: () => server.dispose(),
  }
}

describe("Runtime identity API", () => {
  test("proves identity without authentication but keeps application routes protected", async () => {
    const credential = randomBytes(48).toString("hex")
    const identity = RuntimeIdentity.create("canonical-storage", "test-version", credential)
    identity.bind("http://127.0.0.1:4096/")
    const server = app(credential, identity)
    const challenge = randomBytes(32).toString("hex")
    try {
      const response = await server.request(`/api/runtime/identity?challenge=${challenge}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(identity.prove(challenge))
      expect((await server.request("/api/health")).status).toBe(401)
      expect((await server.request("/api/runtime/identity?challenge=short")).status).toBe(400)
      expect(
        (await server.request(`/api/runtime/identity?challenge=${challenge}`, { method: "POST" })).status,
      ).not.toBe(200)
      expect((await server.request(`/api/runtime/identity/other?challenge=${challenge}`)).status).not.toBe(200)
      const authorized = await server.request("/api/health", {
        headers: { authorization: `Basic ${Buffer.from(`miao:${credential}`).toString("base64")}` },
      })
      expect(authorized.status).toBe(200)
    } finally {
      await server.dispose()
    }
  })

  test("an ordinary server cannot attest a hosted Runtime", async () => {
    const server = app(randomBytes(48).toString("hex"))
    try {
      const response = await server.request(`/api/runtime/identity?challenge=${randomBytes(32).toString("hex")}`)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ _tag: "ServiceUnavailableError", service: "runtime" })
    } finally {
      await server.dispose()
    }
  })
})
