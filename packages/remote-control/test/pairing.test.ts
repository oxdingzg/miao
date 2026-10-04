import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeviceGrants } from "../src/grants"
import { SecureChannel } from "../src/secure-channel"
import { ControlPairing } from "../src/pairing"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-pairing-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, "devices.json")
  const grants = await DeviceGrants.load(filename)
  const target = { hostID: grants.hostID, runtimeID: crypto.randomUUID() }
  const pairing = ControlPairing.make({ grants, target, hubURL: "https://hub.example.invalid" })
  cleanup.push(() => pairing.stop())
  const policy: ControlPairing.Policy = {
    permissions: ["read"],
    projectIDs: [],
    sessionIDs: ["ses_shared"],
    expiresAt: Date.now() + 60000,
  }
  return { grants, target, pairing, policy, filename }
}

test("pairing binds device proof and awaits local approval before persisting its exact scope", async () => {
  const f = await fixture()
  const invitation = f.pairing.issue(f.policy)
  const device = await SecureChannel.createIdentity()
  const handshake = await SecureChannel.startClient(device, f.target)
  const request = {
    pairingID: invitation.pairingID,
    label: "Phone / 手机",
    hello: handshake.hello,
    proof: ControlPairing.proof(invitation, "Phone / 手机", handshake.hello),
  }
  expect(
    ControlPairing.proof(invitation, request.label, Object.fromEntries(Object.entries(handshake.hello).reverse())),
  ).toBe(request.proof)
  const claimed = await f.pairing.claim(request, crypto.randomUUID())
  const client = await handshake.finish(claimed.hello, invitation.hostPublicKey)
  expect(
    new TextDecoder().decode(
      await claimed.channel.open(await client.channel.seal(new TextEncoder().encode("device proof"))),
    ),
  ).toBe("device proof")
  expect(f.grants.active(device.publicKey)).toEqual([])
  expect(f.pairing.list()).toMatchObject([
    { candidate: { publicKey: device.publicKey, label: request.label }, policy: f.policy },
  ])
  expect(JSON.stringify(f.pairing.list())).not.toContain(invitation.secret)
  await expect(
    f.pairing.approve(invitation.pairingID, (await SecureChannel.createIdentity()).publicKey),
  ).rejects.toThrow("Pairing unavailable")
  const approved = await f.pairing.approve(invitation.pairingID, device.publicKey)
  expect(await claimed.result).toEqual(approved)
  expect(approved.permissions).toEqual(["read"])
  expect(approved.sessionIDs).toEqual(["ses_shared"])
  expect(f.grants.active(device.publicKey)).toHaveLength(1)
  await expect(f.pairing.claim(request, crypto.randomUUID())).rejects.toThrow("Pairing unavailable")
  await expect(f.pairing.approve(invitation.pairingID, device.publicKey)).rejects.toThrow("Pairing unavailable")
})

test("pairing rejects forged identity, target substitution and repeated guessing", async () => {
  const f = await fixture()
  const invitation = f.pairing.issue(f.policy)
  const device = await SecureChannel.createIdentity()
  const hello = (await SecureChannel.startClient(device, f.target)).hello
  const impostor = { ...hello, signingKey: (await SecureChannel.createIdentity()).publicKey }
  await expect(
    f.pairing.claim(
      {
        pairingID: invitation.pairingID,
        label: "phone",
        hello: impostor,
        proof: ControlPairing.proof(invitation, "phone", impostor),
      },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("Invalid client signature")
  const other = (await SecureChannel.startClient(device, { ...f.target, runtimeID: crypto.randomUUID() })).hello
  await expect(
    f.pairing.claim(
      {
        pairingID: invitation.pairingID,
        label: "phone",
        hello: other,
        proof: ControlPairing.proof(invitation, "phone", other),
      },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("Client identity or target mismatch")
  for (let attempt = 0; attempt < 8; attempt++)
    await expect(
      f.pairing.claim(
        { pairingID: invitation.pairingID, label: "phone", hello, proof: "0".repeat(64) },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("Pairing unavailable")
  await expect(
    f.pairing.claim(
      {
        pairingID: invitation.pairingID,
        label: "phone",
        hello,
        proof: ControlPairing.proof(invitation, "phone", hello),
      },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("Pairing unavailable")
  expect(f.grants.list()).toEqual([])
})

test("expired and rejected invitations confer no authority and shutdown stops future pairing", async () => {
  const f = await fixture()
  const expired = f.pairing.issue(f.policy, 1)
  const device = await SecureChannel.createIdentity()
  const hello = (await SecureChannel.startClient(device, f.target)).hello
  await Bun.sleep(10)
  await expect(
    f.pairing.claim(
      { pairingID: expired.pairingID, label: "phone", hello, proof: ControlPairing.proof(expired, "phone", hello) },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("Pairing unavailable")
  const invitation = f.pairing.issue(f.policy)
  const claimed = await f.pairing.claim(
    { pairingID: invitation.pairingID, label: "phone", hello, proof: ControlPairing.proof(invitation, "phone", hello) },
    crypto.randomUUID(),
  )
  f.pairing.reject(invitation.pairingID)
  await expect(claimed.result).rejects.toThrow("Pairing unavailable")
  expect(f.grants.list()).toEqual([])
  await f.pairing.stop()
  expect(() => f.pairing.issue(f.policy)).toThrow("Pairing unavailable")
})

test("concurrent claims reserve one candidate and shutdown waits for durable approval", async () => {
  const f = await fixture()
  const invitation = f.pairing.issue(f.policy)
  const device = await SecureChannel.createIdentity()
  const hello = (await SecureChannel.startClient(device, f.target)).hello
  const request = {
    pairingID: invitation.pairingID,
    label: "phone",
    hello,
    proof: ControlPairing.proof(invitation, "phone", hello),
  }
  const claimed = await Promise.allSettled([
    f.pairing.claim(request, crypto.randomUUID()),
    f.pairing.claim(request, crypto.randomUUID()),
  ])
  expect(claimed.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(claimed.filter((result) => result.status === "rejected")).toHaveLength(1)
  const approval = f.pairing.approve(invitation.pairingID, device.publicKey)
  await f.pairing.stop()
  const grant = await approval
  const restored = await DeviceGrants.load(f.filename)
  expect(restored.active(device.publicKey)).toEqual([grant])
  expect(() => f.pairing.issue(f.policy)).toThrow("Pairing unavailable")
})
