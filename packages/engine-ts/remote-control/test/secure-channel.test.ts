import { describe, expect, test } from "bun:test"
import { SecureChannel } from "../src/secure-channel"

const target = { hostID: "host-test-00000000", runtimeID: "runtime-test-00000000" }
const connectionID = "connection-test-00000000"
const text = new TextEncoder()
async function setup() {
  const host = await SecureChannel.createIdentity()
  const device = await SecureChannel.createIdentity()
  const client = await SecureChannel.startClient(device, target)
  const accepted = await SecureChannel.acceptClient(host, target, connectionID, client.hello, device.publicKey)
  const connected = await client.finish(accepted.hello, host.publicKey)
  return { host, device, client, accepted, connected }
}

describe("Remote Control authenticated secure channel", () => {
  test("non-exportable browser identities still authenticate and encrypt", async () => {
    const device = await SecureChannel.createIdentity({ extractable: false })
    expect(device.keys.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("pkcs8", device.keys.privateKey)).rejects.toThrow()
    const host = await SecureChannel.createIdentity()
    const client = await SecureChannel.startClient(device, target)
    const accepted = await SecureChannel.acceptClient(host, target, connectionID, client.hello, device.publicKey)
    const connected = await client.finish(accepted.hello, host.publicKey)
    const packet = await connected.channel.seal(text.encode("browser command"))
    expect(new TextDecoder().decode(await accepted.channel.open(packet))).toBe("browser command")
  })
  test("encrypts bidirectionally with fresh handshake keys", async () => {
    const pair = await setup()
    const first = await pair.connected.channel.seal(text.encode("prompt"))
    expect(new TextDecoder().decode(await pair.accepted.channel.open(first))).toBe("prompt")
    const response = await pair.accepted.channel.seal(text.encode("result"))
    expect(new TextDecoder().decode(await pair.connected.channel.open(response))).toBe("result")
    expect(pair.connected.connectionID).toBe(connectionID)
    const other = await setup()
    await expect(other.accepted.channel.open(first)).rejects.toThrow()
  })

  test("rejects an untrusted device key before returning a channel", async () => {
    const pair = await setup()
    const stranger = await SecureChannel.createIdentity()
    await expect(
      SecureChannel.acceptClient(pair.host, target, connectionID, pair.client.hello, stranger.publicKey),
    ).rejects.toThrow("Client identity or target mismatch")
  })

  test("does not trust a host key supplied by the relay", async () => {
    const host = await SecureChannel.createIdentity()
    const device = await SecureChannel.createIdentity()
    const stranger = await SecureChannel.createIdentity()
    const client = await SecureChannel.startClient(device, target)
    const accepted = await SecureChannel.acceptClient(host, target, connectionID, client.hello, device.publicKey)
    await expect(client.finish(accepted.hello, stranger.publicKey)).rejects.toThrow(
      "Server identity or challenge mismatch",
    )
  })

  test("binds signatures to targets, challenges and routing identities", async () => {
    const pair = await setup()
    await expect(
      SecureChannel.acceptClient(
        pair.host,
        target,
        connectionID,
        { ...pair.client.hello, challenge: "A".repeat(43) },
        pair.device.publicKey,
      ),
    ).rejects.toThrow("Invalid client signature")
    const client = await SecureChannel.startClient(pair.device, target)
    const accepted = await SecureChannel.acceptClient(
      pair.host,
      target,
      connectionID,
      client.hello,
      pair.device.publicKey,
    )
    await expect(
      client.finish({ ...accepted.hello, connectionID: "tampered-connection-00000" }, pair.host.publicKey),
    ).rejects.toThrow("Invalid server signature")
  })

  test("rejects replies from a different handshake and reuse of a completed handshake", async () => {
    const pair = await setup()
    const client = await SecureChannel.startClient(pair.device, target)
    await expect(client.finish(pair.accepted.hello, pair.host.publicKey)).rejects.toThrow(
      "Server identity or challenge mismatch",
    )
    await expect(pair.client.finish(pair.accepted.hello, pair.host.publicKey)).rejects.toThrow("Handshake already used")
  })

  test("serializes receive checks so concurrent replay cannot be accepted", async () => {
    const pair = await setup()
    const packet = await pair.connected.channel.seal(text.encode("once"))
    const results = await Promise.allSettled([pair.accepted.channel.open(packet), pair.accepted.channel.open(packet)])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
  })

  test("rejects reflection, reordering, modification and malformed packets", async () => {
    const pair = await setup()
    const first = await pair.connected.channel.seal(text.encode("first"))
    const second = await pair.connected.channel.seal(text.encode("second"))
    await expect(pair.connected.channel.open(first)).rejects.toThrow()
    await expect(pair.accepted.channel.open(second)).rejects.toThrow("Replayed or out-of-order secure frame")
    const tampered = `${first.slice(0, 15)}${first[15] === "A" ? "B" : "A"}${first.slice(16)}`
    await expect(pair.accepted.channel.open(tampered)).rejects.toThrow()
    await expect(pair.accepted.channel.open("not/base64url")).rejects.toThrow()
    expect(new TextDecoder().decode(await pair.accepted.channel.open(first))).toBe("first")
    expect(new TextDecoder().decode(await pair.accepted.channel.open(second))).toBe("second")
    await expect(pair.accepted.channel.open(first)).rejects.toThrow("Replayed or out-of-order secure frame")
  })

  test("canonicalizes handshake object ordering", async () => {
    const host = await SecureChannel.createIdentity()
    const device = await SecureChannel.createIdentity()
    const client = await SecureChannel.startClient(device, { runtimeID: target.runtimeID, hostID: target.hostID })
    const accepted = await SecureChannel.acceptClient(host, target, connectionID, client.hello, device.publicKey)
    const connected = await client.finish(accepted.hello, host.publicKey)
    const packet = await connected.channel.seal(text.encode("ordered"))
    expect(new TextDecoder().decode(await accepted.channel.open(packet))).toBe("ordered")
  })

  test("serializes concurrent sends without changing caller-owned bytes", async () => {
    const pair = await setup()
    const plaintext = text.encode("snapshot")
    const first = pair.connected.channel.seal(plaintext)
    plaintext.fill(0)
    const packets = await Promise.all([first, pair.connected.channel.seal(text.encode("next"))])
    expect(new TextDecoder().decode(await pair.accepted.channel.open(packets[0]))).toBe("snapshot")
    expect(new TextDecoder().decode(await pair.accepted.channel.open(packets[1]))).toBe("next")
  })

  test("bounds plaintext and encoded frame sizes", async () => {
    const pair = await setup()
    await expect(pair.connected.channel.seal(new Uint8Array(128 * 1024 + 1))).rejects.toThrow(
      "Secure frame exceeds limit",
    )
    await expect(pair.accepted.channel.open("A".repeat(180 * 1024 + 1))).rejects.toThrow("Secure frame exceeds limit")
  })
})
