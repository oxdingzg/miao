import { expect, test } from "bun:test"
import { SecureChannel } from "../src/secure-channel"
import { HostEndorsement } from "../src/host-endorsement"

async function fixture() {
  const signer = await SecureChannel.createIdentity()
  const device = await SecureChannel.createIdentity()
  const host = await SecureChannel.createIdentity()
  const attacker = await SecureChannel.createIdentity()
  const target = { hostID: crypto.randomUUID(), runtimeID: crypto.randomUUID() }
  const started = await SecureChannel.startClient(device, target)
  const payload: HostEndorsement.Payload = {
    version: 1,
    hubURL: "https://relay.example.invalid",
    accountID: "account_" + "a".repeat(24),
    deviceKey: device.publicKey,
    challenge: started.hello.challenge,
    hosts: [{ hostID: target.hostID, publicKey: host.publicKey }],
  }
  const expected = { ...payload, trustedSignerKey: signer.publicKey }
  return { signer, device, host, attacker, target, started, payload, expected }
}
test("an independently pinned device transfers real host trust through an untrusted transport", async () => {
  const f = await fixture()
  const accepted = await HostEndorsement.accept(await HostEndorsement.sign(f.signer, f.payload), f.expected)
  const handshake = await SecureChannel.acceptClient(
    f.host,
    f.target,
    crypto.randomUUID(),
    f.started.hello,
    f.device.publicKey,
  )
  expect((await f.started.finish(handshake.hello, accepted.hosts[0]!.publicKey)).connectionID).toBe(
    handshake.hello.connectionID,
  )
})
test("a Hub cannot substitute either the endorsement signer or host key", async () => {
  const f = await fixture()
  const substituted = { ...f.payload, hosts: [{ hostID: f.target.hostID, publicKey: f.attacker.publicKey }] }
  await expect(HostEndorsement.accept(await HostEndorsement.sign(f.attacker, substituted), f.expected)).rejects.toThrow(
    "independently trusted",
  )
  const signed = await HostEndorsement.sign(f.signer, f.payload)
  await expect(HostEndorsement.accept({ ...signed, payload: substituted }, f.expected)).rejects.toThrow(
    "independently trusted",
  )
  const trusted = await HostEndorsement.accept(signed, f.expected)
  const fake = await SecureChannel.acceptClient(
    f.attacker,
    f.target,
    crypto.randomUUID(),
    f.started.hello,
    f.device.publicKey,
  )
  await expect(f.started.finish(fake.hello, trusted.hosts[0]!.publicKey)).rejects.toThrow("identity")
})
test("endorsements cannot be replayed to another device, enrollment challenge, account or Hub", async () => {
  const f = await fixture()
  const signed = await HostEndorsement.sign(f.signer, f.payload)
  for (const expected of [
    { ...f.expected, deviceKey: f.attacker.publicKey },
    { ...f.expected, challenge: (await SecureChannel.startClient(f.device, f.target)).hello.challenge },
    { ...f.expected, accountID: "account_" + "b".repeat(24) },
    { ...f.expected, hubURL: "https://other.example.invalid" },
  ])
    await expect(HostEndorsement.accept(signed, expected)).rejects.toThrow("this enrollment")
})
