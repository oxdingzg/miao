import { expect, test } from "bun:test"
import { createServer, type ServerHttp2Stream } from "node:http2"
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose"
import { PushProvider } from "../src/push-provider"

const options = {
  teamID: "ABCDEFGHIJ",
  keyID: "KLMNOPQRST",
  topic: "dev.miao.remote",
  environment: "sandbox" as const,
}
const signal = { token: "ab".repeat(32), signalID: "signal_fixture_123456", kind: "attention" as const }

test("APNs sends a signed generic alert over HTTP/2 and classifies delivery without replay", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true })
  const privateKey = await exportPKCS8(keys.privateKey)
  const seen: Array<{ authorization: string; body: string }> = []
  const server = createServer()
  server.on("session", (session) => session.on("error", () => {}))
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = []
    stream.on("error", () => {})
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => {
      expect(headers[":method"]).toBe("POST")
      expect(headers[":path"]).toBe(`/3/device/${signal.token}`)
      expect(headers["apns-topic"]).toBe(options.topic)
      expect(headers["apns-push-type"]).toBe("alert")
      expect(headers["apns-expiration"]).toBe("0")
      seen.push({ authorization: String(headers.authorization), body: Buffer.concat(chunks).toString("utf8") })
      const status = [200, 410, 429, 403][seen.length - 1]!
      stream.respond({ ":status": status })
      stream.end(status === 410 ? JSON.stringify({ reason: "Unregistered", timestamp: 123456 }) : "")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const provider = await PushProvider.create({
    ...options,
    privateKey,
    testEndpoint: `http://127.0.0.1:${address.port}`,
  })
  try {
    expect((await provider.send(signal)).status).toBe("accepted")
    expect(await provider.send(signal)).toMatchObject({ status: "unregistered", timestamp: 123456 })
    expect((await provider.send(signal)).status).toBe("retryable")
    expect((await provider.send(signal)).status).toBe("rejected")
    expect(seen).toHaveLength(4)
    const verified = await jwtVerify(seen[0]!.authorization.slice(7), keys.publicKey, {
      algorithms: ["ES256"],
      issuer: options.teamID,
    })
    expect(verified.protectedHeader.kid).toBe(options.keyID)
    expect(verified.payload.iat).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60)
    expect(seen.every((request) => request.authorization === seen[0]!.authorization)).toBe(true)
    expect(JSON.parse(seen[0]!.body)).toEqual({
      aps: { alert: { title: "miao", body: "A session needs your attention." }, sound: "default" },
      signalID: signal.signalID,
    })
    await expect(provider.send({ ...signal, token: "bad/token" })).rejects.toThrow()
    await expect(provider.send({ ...signal, signalID: "secret\nheader" })).rejects.toThrow()
    provider.stop()
    expect((await provider.send(signal)).status).toBe("rejected")
    expect(seen).toHaveLength(4)
  } finally {
    provider.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("APNs rejects credential forwarding endpoints and invalid signing configuration", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true })
  const privateKey = await exportPKCS8(keys.privateKey)
  for (const testEndpoint of [
    "https://example.invalid",
    "http://localhost:4000",
    "http://127.0.0.1:4000/path",
    "http://user:secret@127.0.0.1:4000",
  ])
    await expect(PushProvider.create({ ...options, privateKey, testEndpoint })).rejects.toThrow("loopback")
  await expect(PushProvider.create({ ...options, privateKey, keyID: "bad\nheader" })).rejects.toThrow("signing")
})

test("APNs bounds concurrent hints and treats a dropped response as unknown", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true })
  const privateKey = await exportPKCS8(keys.privateKey)
  const streams: ServerHttp2Stream[] = []
  const server = createServer()
  server.on("session", (session) => session.on("error", () => {}))
  const ready = Promise.withResolvers<void>()
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    streams.push(stream)
    if (streams.length === 32) ready.resolve()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const provider = await PushProvider.create({
    ...options,
    privateKey,
    testEndpoint: `http://127.0.0.1:${address.port}`,
  })
  try {
    const requests = Array.from({ length: 32 }, () => provider.send(signal))
    await ready.promise
    expect((await provider.send(signal)).status).toBe("retryable")
    streams.forEach((stream) => stream.close())
    expect((await Promise.all(requests)).every((result) => result.status === "unknown")).toBe(true)
    expect(streams).toHaveLength(32)
  } finally {
    provider.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 10_000)
