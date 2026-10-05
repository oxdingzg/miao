import { expect, test } from "bun:test"
import { SecureChannel } from "../src/secure-channel"
import { PushContext } from "../src/push-context"

test("Push context is confidential, host-pinned and bound to every routing field", async () => {
  const host = await SecureChannel.createIdentity()
  const device = await SecureChannel.createIdentity()
  const other = await SecureChannel.createIdentity()
  const binding = {
    hostID: crypto.randomUUID(),
    runtimeID: crypto.randomUUID(),
    grantID: crypto.randomUUID(),
    grantVersion: 1,
    deviceID: device.publicKey,
    signalID: crypto.randomUUID(),
  }
  const payload = { sessionID: "session_secret_123", projectID: "project_secret_123", expiresAt: Date.now() + 300_000 }
  const encoded = await PushContext.seal(host, binding, payload)
  expect(Buffer.from(encoded, "base64url").toString("utf8")).not.toContain(payload.sessionID)
  expect(await PushContext.open(device, host.publicKey, binding, encoded)).toEqual(payload)
  const another = await PushContext.seal(host, binding, payload)
  expect(another).not.toBe(encoded)
  await expect(PushContext.open(device, other.publicKey, binding, encoded)).rejects.toThrow("Untrusted")
  await expect(PushContext.open(other, host.publicKey, binding, encoded)).rejects.toThrow("mismatch")
  for (const replacement of [
    { hostID: crypto.randomUUID() },
    { runtimeID: crypto.randomUUID() },
    { grantID: crypto.randomUUID() },
    { grantVersion: 2 },
    { signalID: crypto.randomUUID() },
  ])
    await expect(PushContext.open(device, host.publicKey, { ...binding, ...replacement }, encoded)).rejects.toThrow(
      "Untrusted",
    )
  const packet = Buffer.from(encoded, "base64url")
  packet[90] = packet[90]! ^ 1
  await expect(PushContext.open(device, host.publicKey, binding, packet.toString("base64url"))).rejects.toThrow(
    "Untrusted",
  )
  await expect(PushContext.open(device, host.publicKey, binding, encoded + "=")).rejects.toThrow("encoding")
  await expect(PushContext.seal(host, binding, { ...payload, expiresAt: 0 })).rejects.toThrow("expired")
  await expect(PushContext.seal(host, binding, { ...payload, expiresAt: Date.now() + 900_000 })).rejects.toThrow(
    "expired",
  )
  await expect(PushContext.seal(host, binding, { ...payload, sessionID: "../other/session" })).rejects.toThrow(
    "payload",
  )
})
