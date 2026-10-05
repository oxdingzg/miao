import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { HubService } from "../src/hub-service"
import { SecureChannel } from "../src/secure-channel"
import { HubAuth } from "../src/hub-auth"

test("Browser upgrades use one-use host/Runtime tickets and retain live login authorization", async () => {
  const database = new Database(":memory:")
  const origin = "http://127.0.0.1:4600"
  const server = await HubService.listen({
    database,
    baseURL: origin,
    secret: "browser-test-secret-000000000000000000000000",
    allowLoopbackHTTP: true,
    port: 0,
    migrate: true,
    bootstrap: { name: "Owner", email: "browser@example.invalid", password: "browser-fixture-password-0001" },
  })
  const base = `http://127.0.0.1:${server.port}`
  const sockets: WebSocket[] = []
  const request = (route: string, token?: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  async function connect(route: string, headers: Record<string, string>, protocols?: string[]) {
    const socket = new WebSocket(base.replace("http:", "ws:") + route, { headers, protocols })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser fixture connection timed out")), 5000)
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error("Browser fixture connection rejected"))
        },
        { once: true },
      )
    })
    return socket
  }
  try {
    const signedIn = await request("/api/auth/sign-in/email", undefined, {
      email: "browser@example.invalid",
      password: "browser-fixture-password-0001",
    })
    expect(signedIn.status).toBe(200)
    const login = signedIn.headers.get("set-auth-token")!
    const jwt = ((await (await request("/api/auth/token", login)).json()) as { token: string }).token
    const hostID = crypto.randomUUID()
    const runtimeID = crypto.randomUUID()
    const registration = await request("/api/hub/hosts", jwt, {
      hostID,
      name: "Browser host",
      publicKey: (await SecureChannel.createIdentity()).publicKey,
    })
    const hostToken = ((await registration.json()) as { token: string }).token
    expect((await request("/api/hub/tickets", undefined, { hostID, runtimeID })).status).toBe(401)
    expect((await request("/api/hub/tickets", jwt, { hostID, runtimeID })).status).toBe(503)
    const host = await connect(`/v1/host?hostID=${hostID}&runtimeID=${runtimeID}`, {
      authorization: "Bearer " + hostToken,
    })
    const authority = await HubAuth.create({
      database,
      baseURL: origin,
      secret: "browser-test-secret-000000000000000000000000",
      allowLoopbackHTTP: true,
      migrate: false,
    })
    const context = await authority.auth.$context
    const user = await context.internalAdapter.createUser(
      { name: "Other", email: "other-browser@example.invalid", emailVerified: false },
      { method: "admin" },
    )
    await context.internalAdapter.createAccount({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await context.password.hash("other-browser-password-0001"),
    })
    const otherLogin = await request("/api/auth/sign-in/email", undefined, {
      email: user.email,
      password: "other-browser-password-0001",
    })
    expect(otherLogin.status).toBe(200)
    const otherJwt = (
      (await (await request("/api/auth/token", otherLogin.headers.get("set-auth-token")!)).json()) as { token: string }
    ).token
    expect((await request("/api/hub/tickets", otherJwt, { hostID, runtimeID })).status).toBe(404)
    expect((await request("/api/hub/tickets", jwt, { hostID, runtimeID: crypto.randomUUID() })).status).toBe(503)
    const mint = async () => {
      const response = await request("/api/hub/tickets", jwt, { hostID, runtimeID })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      return ((await response.json()) as { ticket: string }).ticket
    }
    const route = `/v1/client?hostID=${hostID}`
    const wrong = await mint()
    expect(
      (
        await request(`/v1/client?hostID=${crypto.randomUUID()}`, undefined, undefined, {
          "sec-websocket-protocol": `miao.control.v1, miao.ticket.${wrong}`,
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request(route, undefined, undefined, {
          "sec-websocket-protocol": `miao.control.v1, miao.ticket.${wrong}`,
        })
      ).status,
    ).toBe(401)
    const ticket = await mint()
    const offered = ["miao.control.v1", "miao.ticket." + ticket]
    expect(
      (
        await request(route, undefined, undefined, {
          "sec-websocket-protocol": offered.join(","),
          origin: "https://other.invalid",
        })
      ).status,
    ).toBe(403)
    expect((await request(route + `&ticket=${ticket}`)).status).toBe(401)
    expect(
      (
        await request(`/v1/host?hostID=${hostID}&runtimeID=${runtimeID}`, undefined, undefined, {
          "sec-websocket-protocol": offered.join(","),
        })
      ).status,
    ).toBe(401)
    const joined = new Promise<string>((resolve) =>
      host.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    )
    const client = await connect(route, { origin }, offered)
    expect(client.protocol).toBe("miao.control.v1")
    const connectionID = (JSON.parse(await joined) as { connectionID: string }).connectionID
    expect((await request(route, undefined, undefined, { "sec-websocket-protocol": offered.join(",") })).status).toBe(
      401,
    )
    const forwarded = new Promise<string>((resolve) =>
      host.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    )
    client.send("c2VhbGVkLWJyb3dzZXItZnJhbWU")
    expect(JSON.parse(await forwarded)).toMatchObject({
      type: "frame",
      connectionID,
      payload: "c2VhbGVkLWJyb3dzZXItZnJhbWU",
    })
    const late = await mint()
    const received: string[] = []
    client.addEventListener("message", (event) => received.push(String(event.data)))
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser logout did not close transport")), 4000)
      client.addEventListener(
        "close",
        (event) => {
          clearTimeout(timer)
          resolve(event.code)
        },
        { once: true },
      )
    })
    expect((await request("/api/auth/sign-out", login, {})).status).toBe(200)
    host.send(JSON.stringify({ type: "frame", connectionID, payload: "bGF0ZS1yZXNwb25zZQ" }))
    expect(await closed).toBe(1008)
    expect(received).toEqual([])
    expect(host.readyState).toBe(WebSocket.OPEN)
    expect(
      (await request(route, undefined, undefined, { "sec-websocket-protocol": `miao.control.v1, miao.ticket.${late}` }))
        .status,
    ).toBe(401)
    const freshLogin = await request("/api/auth/sign-in/email", undefined, {
      email: "browser@example.invalid",
      password: "browser-fixture-password-0001",
    })
    const freshJwt = (
      (await (await request("/api/auth/token", freshLogin.headers.get("set-auth-token")!)).json()) as { token: string }
    ).token
    const beforeRestart = await request("/api/hub/tickets", freshJwt, { hostID, runtimeID })
    expect(beforeRestart.status).toBe(200)
    const oldRuntimeTicket = ((await beforeRestart.json()) as { ticket: string }).ticket
    const hostClosed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Old Runtime did not disconnect")), 4000)
      host.addEventListener(
        "close",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    host.close()
    await hostClosed
    const nextRuntimeID = crypto.randomUUID()
    await connect(`/v1/host?hostID=${hostID}&runtimeID=${nextRuntimeID}`, { authorization: "Bearer " + hostToken })
    expect(
      (
        await request(route, undefined, undefined, {
          "sec-websocket-protocol": `miao.control.v1, miao.ticket.${oldRuntimeTicket}`,
        })
      ).status,
    ).toBe(409)
    expect(await (await request("/api/hub/hosts", freshJwt)).json()).toMatchObject({
      data: [{ hostID, runtimeID: nextRuntimeID, online: true }],
    })
    expect((await request(`/api/hub/hosts/${hostID}/rotate`, freshJwt, {})).status).toBe(200)
    expect(await (await request("/api/hub/hosts", freshJwt)).json()).toMatchObject({
      data: [{ hostID, runtimeID: null, online: false }],
    })
    expect((await request("/api/hub/tickets", freshJwt, { hostID, runtimeID: nextRuntimeID })).status).toBe(503)
  } finally {
    sockets.forEach((socket) => socket.close())
    await server.stop()
    database.close()
  }
}, 30_000)
