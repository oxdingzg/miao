import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { HubService } from "../src/hub-service"
import { SecureChannel } from "../src/secure-channel"
import { PushRegistry } from "../src/push-registry"

test("Hub push registration requires a live account and origin, supports rotation/revocation and prunes on logout", async () => {
  const database = new Database(":memory:")
  const baseURL = "http://127.0.0.1:4600"
  const server = await HubService.listen({
    database,
    baseURL,
    secret: "fixture-push-api-secret-000000000000000000",
    allowLoopbackHTTP: true,
    port: 0,
    migrate: true,
    pushRegistrations: true,
    bootstrap: { email: "owner@example.invalid", password: "fixture-password-0001", name: "Owner" },
  })
  const url = `http://127.0.0.1:${server.port}`
  const request = (route: string, token?: string, body?: unknown, origin = baseURL) =>
    fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  try {
    const device = await SecureChannel.createIdentity()
    const registration = { deviceID: device.publicKey, token: "ab".repeat(32), environment: "sandbox" }
    expect((await request("/api/hub/push/register", undefined, registration)).status).toBe(401)
    const signedIn = await request("/api/auth/sign-in/email", undefined, {
      email: "owner@example.invalid",
      password: "fixture-password-0001",
    })
    const login = signedIn.headers.get("set-auth-token")!
    const issued = await request("/api/auth/token", login)
    const access = ((await issued.json()) as { token: string }).token
    const version = await request("/api/hub/version", access)
    expect(((await version.json()) as { capabilities: string[] }).capabilities).toContain("push-registration")
    expect(
      (await request("/api/hub/push/register", access, registration, "https://other.example.invalid")).status,
    ).toBe(403)
    expect((await request("/api/hub/push/register", access, { ...registration, token: "bad/token" })).status).toBe(409)
    expect(
      (await request("/api/hub/push/register", access, { ...registration, padding: "x".repeat(5000) })).status,
    ).toBe(400)
    const registered = await request("/api/hub/push/register", access, registration)
    expect(registered.status).toBe(200)
    expect(registered.headers.get("cache-control")).toBe("no-store")
    const first = (await registered.json()) as { registrationID: string }
    const replacement = await request("/api/hub/push/register", access, { ...registration, token: "cd".repeat(32) })
    expect(replacement.status).toBe(200)
    expect(((await replacement.json()) as { registrationID: string }).registrationID).not.toBe(first.registrationID)
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM hub_push_device").get()?.count).toBe(1)
    expect((await request("/api/hub/push/revoke", access, { deviceID: device.publicKey })).status).toBe(200)
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM hub_push_device").get()?.count).toBe(0)
    await request("/api/hub/push/register", access, registration)
    expect((await request("/api/auth/sign-out", login, {})).status).toBe(200)
    expect((await request("/api/hub/push/register", access, registration)).status).toBe(401)
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM hub_push_device").get()?.count).toBe(0)
    expect(PushRegistry.open(database).targets("unknown-account")).toEqual([])
  } finally {
    await server.stop()
    database.close()
  }
})

test("Hub does not advertise or expose push registration when disabled", async () => {
  const database = new Database(":memory:")
  const baseURL = "http://127.0.0.1:4600"
  const server = await HubService.listen({
    database,
    baseURL,
    secret: "fixture-push-disabled-secret-000000000000",
    allowLoopbackHTTP: true,
    port: 0,
    migrate: true,
    bootstrap: { email: "owner@example.invalid", password: "fixture-password-0001", name: "Owner" },
  })
  try {
    expect(database.query("SELECT name FROM sqlite_master WHERE name = 'hub_push_device'").get()).toBeNull()
    const url = `http://127.0.0.1:${server.port}`
    const login = await fetch(url + "/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin: baseURL, "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.invalid", password: "fixture-password-0001" }),
      signal: AbortSignal.timeout(5000),
    })
    const issued = await fetch(url + "/api/auth/token", {
      headers: { origin: baseURL, authorization: `Bearer ${login.headers.get("set-auth-token")!}` },
      signal: AbortSignal.timeout(5000),
    })
    const token = ((await issued.json()) as { token: string }).token
    const version = await fetch(url + "/api/hub/version", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    expect(((await version.json()) as { capabilities: string[] }).capabilities).not.toContain("push-registration")
    const rejected = await fetch(url + "/api/hub/push/register", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    })
    expect(rejected.status).toBe(404)
  } finally {
    await server.stop()
    database.close()
  }
})
