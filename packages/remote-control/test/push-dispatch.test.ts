import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createServer } from "node:http2"
import { exportPKCS8, generateKeyPair } from "jose"
import { PushRegistry } from "../src/push-registry"
import { PushProvider } from "../src/push-provider"
import { PushDispatch } from "../src/push-dispatch"
import { SecureChannel } from "../src/secure-channel"

test("Notification dispatch uses real HTTP/2, isolates lookup, deduplicates and fences revoked grants and registrations", async () => {
  const database = new Database(":memory:")
  database.exec(
    'CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE "session" (id TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" TEXT)',
  )
  database.query('INSERT INTO "user" (id) VALUES (?)').run("fixture-account")
  database
    .query('INSERT INTO "session" (id, "userId", "expiresAt") VALUES (?, ?, ?)')
    .run("fixture-login", "fixture-account", new Date(Date.now() + 60_000).toISOString())
  PushRegistry.migrate(database)
  const registry = PushRegistry.open(database)
  const principal = { accountID: "fixture-account", sessionID: "fixture-login", expiresAt: Date.now() + 60_000 }
  const device = await SecureChannel.createIdentity()
  const registration = { deviceID: device.publicKey, token: "ab".repeat(32), environment: "sandbox" as const }
  await registry.register(principal, registration, () => true)
  const state = { calls: 0, allowed: true, status: 200 }
  const server = createServer()
  server.on("session", (session) => session.on("error", () => {}))
  server.on("stream", (stream) => {
    state.calls += 1
    stream.on("error", () => {})
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => {
      const payload = Buffer.concat(chunks).toString("utf8")
      expect(payload).not.toContain("encrypted_context")
      expect(payload).not.toContain("grant_fixture")
      stream.respond({ ":status": state.status })
      stream.end(state.status === 410 ? JSON.stringify({ timestamp: Date.now() + 1000 }) : "")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const keys = await generateKeyPair("ES256", { extractable: true })
  const provider = await PushProvider.create({
    teamID: "ABCDEFGHIJ",
    keyID: "KLMNOPQRST",
    topic: "dev.miao.remote",
    privateKey: await exportPKCS8(keys.privateKey),
    environment: "sandbox",
    testEndpoint: `http://127.0.0.1:${address.port}`,
  })
  const dispatcher = PushDispatch.make({ registry, provider, environment: "sandbox", authorized: () => state.allowed })
  const notice = {
    signalID: crypto.randomUUID(),
    accountID: principal.accountID,
    deviceID: device.publicKey,
    hostID: crypto.randomUUID(),
    runtimeID: crypto.randomUUID(),
    grantID: "grant_fixture_123456",
    grantVersion: 1,
    kind: "attention" as const,
    context: "encrypted_context_" + "x".repeat(32),
  }
  try {
    expect(await dispatcher.send(notice)).toEqual({ status: "accepted" })
    expect(await dispatcher.send(notice)).toEqual({ status: "accepted" })
    expect(state.calls).toBe(1)
    expect(await dispatcher.send({ ...notice, kind: "completed" })).toEqual({ status: "rejected" })
    expect(dispatcher.get(principal.accountID, device.publicKey, notice.signalID)?.context).toBe(notice.context)
    await registry.register(principal, registration, () => true)
    expect(dispatcher.get(principal.accountID, device.publicKey, notice.signalID)?.context).toBe(notice.context)
    expect(dispatcher.get("other-account", device.publicKey, notice.signalID)).toBeUndefined()
    expect(dispatcher.get(principal.accountID, "other-device", notice.signalID)).toBeUndefined()
    state.allowed = false
    expect(dispatcher.get(principal.accountID, device.publicKey, notice.signalID)).toBeUndefined()
    expect(await dispatcher.send({ ...notice, signalID: crypto.randomUUID() })).toEqual({ status: "rejected" })
    state.allowed = true
    const pendingNotice = { ...notice, signalID: crypto.randomUUID() }
    const pending = dispatcher.send(pendingNotice)
    dispatcher.revoke(notice.hostID, notice.grantID)
    expect(await pending).toEqual({ status: "rejected" })
    expect(state.calls).toBe(1)
    expect(dispatcher.get(principal.accountID, device.publicKey, notice.signalID)).toBeUndefined()
    state.status = 410
    expect(await dispatcher.send({ ...notice, signalID: crypto.randomUUID() })).toEqual({ status: "unregistered" })
    expect(registry.targets(principal.accountID)).toHaveLength(0)
    await registry.register(principal, registration, () => true)
    state.status = 503
    const retryable = { ...notice, signalID: crypto.randomUUID() }
    expect(await dispatcher.send(retryable)).toEqual({ status: "retryable" })
    expect(await dispatcher.send(retryable)).toEqual({ status: "retryable" })
    expect(state.calls).toBe(3)
    database.query('DELETE FROM "session"').run()
    expect(dispatcher.get(principal.accountID, device.publicKey, retryable.signalID)).toBeUndefined()
    expect(await dispatcher.send({ ...notice, signalID: crypto.randomUUID() })).toEqual({ status: "rejected" })
    dispatcher.stop()
    expect(await dispatcher.send(notice)).toEqual({ status: "rejected" })
  } finally {
    dispatcher.stop()
    provider.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    database.close()
  }
})
