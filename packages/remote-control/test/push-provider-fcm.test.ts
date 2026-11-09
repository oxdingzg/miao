import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { generateKeyPairSync } from "node:crypto"
import { PushProviderFcm } from "../src/push-provider-fcm"

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const TOKEN = "fcm-token_" + "a".repeat(40)

type Seen = { authorization?: string; body: string; path: string }

function fixture(status = 200, response: unknown = { name: "projects/demo/messages/1" }) {
  const seen: Seen[] = []
  let tokenRequests = 0
  const server = createServer((request, response_) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      if (request.url === "/token") {
        tokenRequests += 1
        expect(request.method).toBe("POST")
        const form = new URLSearchParams(body)
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
        response_.writeHead(200, { "content-type": "application/json" })
        response_.end(JSON.stringify({ access_token: "token-value", expires_in: 3600 }))
        return
      }
      seen.push({ authorization: request.headers.authorization, body, path: request.url ?? "" })
      response_.writeHead(status, { "content-type": "application/json" })
      response_.end(JSON.stringify(response))
    })
  })
  return new Promise<{ origin: string; seen: Seen[]; tokenRequests: () => number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "string" || address === null) throw new Error("fixture did not bind")
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        seen,
        tokenRequests: () => tokenRequests,
      })
      void server
    })
  })
}

function provider(origin: string) {
  return PushProviderFcm.create({
    projectID: "demo-project",
    clientEmail: "miao@demo-project.iam.gserviceaccount.com",
    privateKey,
    tokenEndpoint: origin,
    messageEndpoint: origin,
  })
}

describe("FCM push provider", () => {
  test("sends only the generic hint and caches the access token", async () => {
    const server = await fixture()
    const sender = await provider(server.origin)
    const first = await sender.send({ token: TOKEN, signalID: "signal-identifier-0001", kind: "attention" })
    expect(first.status).toBe("accepted")
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]!.authorization).toBe("Bearer token-value")
    expect(server.seen[0]!.path).toBe("/v1/projects/demo-project/messages:send")
    const body = JSON.parse(server.seen[0]!.body)
    expect(body.message.token).toBe(TOKEN)
    expect(body.message.notification).toEqual({ title: "miao", body: "A session needs your attention." })
    expect(body.message.data).toEqual({ signalID: "signal-identifier-0001", kind: "attention" })
    expect(Object.keys(body.message).sort()).toEqual(["data", "notification", "token"])
    expect(Object.keys(body.message.data).sort()).toEqual(["kind", "signalID"])
    expect(Object.keys(body.message.notification).sort()).toEqual(["body", "title"])

    const second = await sender.send({ token: TOKEN, signalID: "signal-identifier-0002", kind: "completed" })
    expect(second.status).toBe("accepted")
    expect(server.tokenRequests()).toBe(1)

    sender.stop()
    expect((await sender.send({ token: TOKEN, signalID: "signal-identifier-0003", kind: "attention" })).status).toBe(
      "rejected",
    )
  })

  test("maps unregistered, retryable and rejected responses", async () => {
    const missing = await fixture(404, { error: { status: "NOT_FOUND" } })
    const sender = await provider(missing.origin)
    expect((await sender.send({ token: TOKEN, signalID: "signal-identifier-0004", kind: "attention" })).status).toBe(
      "rejected",
    )
    sender.stop()

    const busy = await fixture(429, { error: { status: "RESOURCE_EXHAUSTED" } })
    const retrying = await provider(busy.origin)
    expect((await retrying.send({ token: TOKEN, signalID: "signal-identifier-0005", kind: "attention" })).status).toBe(
      "retryable",
    )
    retrying.stop()

    const denied = await fixture(403, { error: { status: "PERMISSION_DENIED" } })
    const rejecting = await provider(denied.origin)
    expect((await rejecting.send({ token: TOKEN, signalID: "signal-identifier-0006", kind: "attention" })).status).toBe(
      "rejected",
    )
    rejecting.stop()
  })

  test("rejects malformed inputs before any request", async () => {
    const server = await fixture()
    const sender = await provider(server.origin)
    await expect(sender.send({ token: "short", signalID: "signal-identifier-0007", kind: "attention" })).rejects.toThrow()
    await expect(sender.send({ token: TOKEN, signalID: "bad id", kind: "attention" })).rejects.toThrow()
    expect(server.seen).toHaveLength(0)
    sender.stop()
  })

  test("requires a service-account identity", async () => {
    await expect(
      PushProviderFcm.create({ projectID: "demo", clientEmail: "miao@example.com", privateKey }),
    ).rejects.toThrow()
  })
})
