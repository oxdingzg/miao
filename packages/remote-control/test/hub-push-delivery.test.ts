import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createServer } from "node:http2"
import { exportPKCS8, generateKeyPair } from "jose"
import { HubService } from "../src/hub-service"
import { SecureChannel } from "../src/secure-channel"

test("Hub delivers opaque host notifications and fences runtime, grant, device and host revocation", async () => {
  const apple = createServer()
  const received: string[] = []
  apple.on("session", (session) => session.on("error", () => {}))
  apple.on("stream", (stream) => {
    const chunks: Buffer[] = []
    stream.on("error", () => {})
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"))
      stream.respond({ ":status": 200 })
      stream.end()
    })
  })
  await new Promise<void>((resolve) => apple.listen(0, "127.0.0.1", resolve))
  const address = apple.address()
  if (!address || typeof address === "string") throw new Error("Missing HTTP/2 fixture")
  const keys = await generateKeyPair("ES256", { extractable: true })
  const database = new Database(":memory:")
  const baseURL = "http://127.0.0.1:4600"
  const server = await HubService.listen({
    database,
    baseURL,
    secret: "fixture-delivery-secret-000000000000000000",
    allowLoopbackHTTP: true,
    port: 0,
    migrate: true,
    pushRegistrations: true,
    pushProvider: {
      teamID: "ABCDEFGHIJ",
      keyID: "KLMNOPQRST",
      topic: "dev.miao.remote",
      privateKey: await exportPKCS8(keys.privateKey),
      environment: "sandbox",
      testEndpoint: `http://127.0.0.1:${address.port}`,
    },
    bootstrap: { email: "owner@example.invalid", password: "fixture-password-0001", name: "Owner" },
  })
  const url = `http://127.0.0.1:${server.port}`
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
  const sockets: WebSocket[] = []
  try {
    const signedIn = await request("/api/auth/sign-in/email", undefined, {
      email: "owner@example.invalid",
      password: "fixture-password-0001",
    })
    const issued = await request("/api/auth/token", signedIn.headers.get("set-auth-token")!)
    const access = ((await issued.json()) as { token: string }).token
    const device = await SecureChannel.createIdentity()
    const host = await SecureChannel.createIdentity()
    const hostID = crypto.randomUUID()
    const runtimeID = crypto.randomUUID()
    const grantID = crypto.randomUUID()
    const credential = await request("/api/hub/hosts", access, { hostID, name: "Computer", publicKey: host.publicKey })
    const token = ((await credential.json()) as { token: string }).token
    await request("/api/hub/push/register", access, {
      deviceID: device.publicKey,
      token: "ab".repeat(32),
      environment: "sandbox",
    })
    const notice = {
      signalID: crypto.randomUUID(),
      deviceID: device.publicKey,
      runtimeID,
      grantID,
      grantVersion: 1,
      kind: "attention",
      context: "encrypted_context_" + "x".repeat(32),
    }
    const send = `/api/hub/hosts/${hostID}/push/send`
    expect((await request(send, access, notice)).status).toBe(401)
    expect(await (await request(send, token, notice)).json()).toEqual({ status: "rejected" })
    const socket = new WebSocket(url.replace("http:", "ws:") + `/v1/host?hostID=${hostID}&runtimeID=${runtimeID}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("Host connection failed")), { once: true })
    })
    expect(await (await request(send, token, notice)).json()).toEqual({ status: "accepted" })
    expect(await (await request(send, token, notice)).json()).toEqual({ status: "accepted" })
    expect(received).toHaveLength(1)
    expect(received[0]).not.toContain(notice.context)
    expect(received[0]).not.toContain(grantID)
    const lookup = `/api/hub/push/context?deviceID=${device.publicKey}&signalID=${notice.signalID}`
    const context = await request(lookup, access)
    expect(context.status).toBe(200)
    expect(context.headers.get("cache-control")).toBe("no-store")
    expect(await context.json()).toMatchObject({ hostID, runtimeID, context: notice.context })
    expect((await request(lookup, token)).status).toBe(401)
    expect((await request(lookup.replace(device.publicKey, "other-device"), access)).status).toBe(404)
    expect(
      await (
        await request(send, token, { ...notice, runtimeID: crypto.randomUUID(), signalID: crypto.randomUUID() })
      ).json(),
    ).toEqual({ status: "rejected" })
    expect((await request(`/api/hub/hosts/${hostID}/push/revoke`, token, { grantID, grantVersion: 1 })).status).toBe(
      200,
    )
    expect((await request(lookup, access)).status).toBe(404)
    expect(await (await request(send, token, { ...notice, signalID: crypto.randomUUID() })).json()).toEqual({
      status: "rejected",
    })
    expect(
      await (await request(send, token, { ...notice, signalID: crypto.randomUUID(), grantVersion: 2 })).json(),
    ).toEqual({ status: "accepted" })
    expect(database.query<{ version: number }, []>("SELECT version FROM hub_push_revocation").get()?.version).toBe(1)
    await request(`/api/hub/hosts/${hostID}/rotate`, access, {})
    expect((await request(send, token, { ...notice, signalID: crypto.randomUUID(), grantVersion: 2 })).status).toBe(401)
    expect(received).toHaveLength(2)
  } finally {
    for (const socket of sockets) socket.close()
    await server.stop()
    await new Promise<void>((resolve) => apple.close(() => resolve()))
    database.close()
  }
}, 20_000)
