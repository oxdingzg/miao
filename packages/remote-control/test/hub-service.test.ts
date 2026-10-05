import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { HubService } from "../src/hub-service"
import { HubAuth } from "../src/hub-auth"
import { SecureChannel } from "../src/secure-channel"

test("Authenticated HTTP directory and opaque WebSocket relay bind roles, accounts and live revocation", async () => {
  const database = new Database(":memory:")
  const baseURL = "http://127.0.0.1:4600"
  const secret = "test-auth-secret-000000000000000000000000000"
  const server = await HubService.listen({
    database,
    baseURL,
    secret,
    allowLoopbackHTTP: true,
    port: 0,
    maxClientsPerAccount: 1,
    migrate: true,
    bootstrap: { name: "Owner", email: "owner@example.invalid", password: "fixture-password-0001" },
  })
  const url = `http://127.0.0.1:${server.port}`
  const sockets: WebSocket[] = []
  const request = (route: string, token?: string, body?: unknown) =>
    fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: baseURL,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  async function login(email: string, password: string) {
    const response = await request("/api/auth/sign-in/email", undefined, { email, password })
    expect(response.status).toBe(200)
    const login = response.headers.get("set-auth-token")!
    const issued = await request("/api/auth/token", login)
    expect(issued.status).toBe(200)
    return { login, access: ((await issued.json()) as { token: string }).token }
  }
  async function connect(route: string, token: string) {
    const socket = new WebSocket(url.replace("http:", "ws:") + route, { headers: { authorization: `Bearer ${token}` } })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("Fixture WebSocket failed")), { once: true })
    })
    return socket
  }
  function closed(socket: WebSocket) {
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Revocation did not close the live socket")), 4000)
      socket.addEventListener(
        "close",
        (event) => {
          clearTimeout(timeout)
          resolve(event.code)
        },
        { once: true },
      )
    })
  }
  try {
    expect((await request("/api/hub/hosts")).status).toBe(401)
    expect(
      (
        await request("/api/auth/sign-up/email", undefined, {
          email: "open@example.invalid",
          password: "fixture-password-0002",
          name: "Open",
        })
      ).status,
    ).toBe(404)
    const owner = await login("owner@example.invalid", "fixture-password-0001")
    const identity = await SecureChannel.createIdentity()
    const hostID = crypto.randomUUID()
    const registration = await request("/api/hub/hosts", owner.access, {
      hostID,
      publicKey: identity.publicKey,
      name: "Home computer",
    })
    expect(registration.status).toBe(201)
    expect(registration.headers.get("cache-control")).toBe("no-store")
    const credential = (await registration.json()) as { token: string }
    const directory = await request("/api/hub/hosts", owner.access)
    expect(await directory.json()).toMatchObject({ data: [{ hostID, online: false, runtimeID: null }] })
    const authority = await HubAuth.create({ database, baseURL, secret, allowLoopbackHTTP: true })
    const context = await authority.auth.$context
    const user = await context.internalAdapter.createUser(
      { name: "Other", email: "other@example.invalid", emailVerified: false },
      { method: "admin" },
    )
    await context.internalAdapter.createAccount({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await context.password.hash("fixture-password-0002"),
    })
    const other = await login("other@example.invalid", "fixture-password-0002")
    expect(await (await request("/api/hub/hosts", other.access)).json()).toEqual({ data: [] })
    const hostRoute = `/v1/host?hostID=${hostID}&runtimeID=runtime-0000000000`
    const clientRoute = `/v1/client?hostID=${hostID}`
    expect((await request(hostRoute, owner.access)).status).toBe(401)
    expect((await request(clientRoute, credential.token)).status).toBe(401)
    expect((await request(clientRoute, other.access)).status).toBe(401)
    expect((await request(clientRoute)).status).toBe(401)
    const host = await connect(hostRoute, credential.token)
    expect(await (await request("/api/hub/hosts", owner.access)).json()).toMatchObject({
      data: [{ hostID, online: true, runtimeID: "runtime-0000000000" }],
    })
    const joined = new Promise<string>((resolve) =>
      host.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    )
    const client = await connect(clientRoute, owner.access)
    expect(JSON.parse(await joined).type).toBe("connected")
    expect((await request(clientRoute, owner.access)).status).toBe(429)
    const secondHostID = crypto.randomUUID()
    const secondRegistration = await request("/api/hub/hosts", owner.access, {
      hostID: secondHostID,
      publicKey: identity.publicKey,
      name: "Second computer",
    })
    expect(secondRegistration.status).toBe(201)
    const secondCredential = (await secondRegistration.json()) as { token: string }
    await connect(`/v1/host?hostID=${secondHostID}&runtimeID=runtime-0000000001`, secondCredential.token)
    expect((await request(`/v1/client?hostID=${secondHostID}`, owner.access)).status).toBe(429)
    const frame = new Promise<string>((resolve) =>
      host.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    )
    client.send("c2VhbGVkLWZyYW1l")
    expect(JSON.parse(await frame).payload).toBe("c2VhbGVkLWZyYW1l")
    const clientClosed = closed(client)
    expect((await request("/api/auth/sign-out", owner.login, {})).status).toBe(200)
    expect((await request("/api/hub/hosts", owner.access)).status).toBe(401)
    expect(await clientClosed).toBe(1008)
    expect(host.readyState).toBe(WebSocket.OPEN)
    const fresh = await login("owner@example.invalid", "fixture-password-0001")
    const hostClosed = closed(host)
    expect((await request(`/api/hub/hosts/${hostID}/revoke`, fresh.access, {})).status).toBe(200)
    expect(await hostClosed).toBe(1008)
    expect((await request(hostRoute, credential.token)).status).toBe(401)
  } finally {
    sockets.forEach((socket) => socket.close())
    await server.stop()
    database.close()
  }
})
