import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { DeviceGrants } from "../src/grants"
import { DeviceRoster } from "../src/device-roster"
import { SecureChannel } from "../src/secure-channel"

const accountID = "account_" + "a".repeat(24)
const hubURL = "https://relay.example.invalid"
async function fixture(action: (store: DeviceGrants.Store, filename: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "miao-roster-"))
  const filename = path.join(root, "devices.json")
  const store = await DeviceGrants.load(filename)
  try {
    await action(store, filename)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}
const policy = () => ({
  permissions: ["read" as const],
  projectIDs: ["project-one"],
  sessionIDs: [],
  expiresAt: Date.now() + 60000,
})
async function bind(store: DeviceGrants.Store, owner: SecureChannel.Identity) {
  const grant = await store.approve({ ...policy(), publicKey: owner.publicKey, label: "Owner" })
  await store.bindAccount({ hubURL, accountID, grantID: grant.id, grantVersion: grant.version, policy: policy() })
  return grant
}
function roster(devices: DeviceRoster.Device[], sequence: number): DeviceRoster.Roster {
  return {
    version: 1,
    accountID,
    sequence,
    issuedAt: 0,
    devices: devices.sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1)),
  }
}
test("binding requires an approved live device and does not bootstrap from Hub claims", () =>
  fixture(async (store) => {
    await expect(
      store.bindAccount({ hubURL, accountID, grantID: crypto.randomUUID(), grantVersion: 1, policy: policy() }),
    ).rejects.toThrow("approved live")
    expect(store.accountTrust()).toBeUndefined()
    const owner = await SecureChannel.createIdentity()
    await bind(store, owner)
    expect(store.accountTrust()).toMatchObject({ accountID, hubURL, acceptedSequence: 0 })
    await expect(
      store.bindAccount({ hubURL, accountID, grantID: crypto.randomUUID(), grantVersion: 1, policy: policy() }),
    ).rejects.toThrow("already bound")
  }))
test("invalid signatures and cross-Hub authority leave persisted state byte-for-byte unchanged", () =>
  fixture(async (store, filename) => {
    const owner = await SecureChannel.createIdentity()
    const attacker = await SecureChannel.createIdentity()
    await bind(store, owner)
    const before = await readFile(filename, "utf8")
    const signed = await DeviceRoster.sign(
      attacker,
      roster([{ publicKey: attacker.publicKey, label: "Attacker", signer: true, addedAt: 0 }], 1),
    )
    await expect(store.acceptRoster(hubURL, signed)).rejects.toThrow("locally trusted")
    await expect(store.acceptRoster("https://other.example.invalid", signed)).rejects.toThrow("locally bound")
    expect(await readFile(filename, "utf8")).toBe(before)
  }))
test("removing a device atomically revokes its existing grants and survives reopening", () =>
  fixture(async (store, filename) => {
    const owner = await SecureChannel.createIdentity()
    const other = await SecureChannel.createIdentity()
    const grant = await bind(store, owner)
    const devices = [
      { publicKey: owner.publicKey, label: "Owner", signer: true, addedAt: 0 },
      { publicKey: other.publicKey, label: "Other", signer: false, addedAt: 0 },
    ]
    await store.acceptRoster(hubURL, await DeviceRoster.sign(owner, roster(devices, 1)))
    const otherGrant = await store.approve({ ...policy(), publicKey: other.publicKey, label: "Other" })
    await store.acceptRoster(
      hubURL,
      await DeviceRoster.sign(
        owner,
        roster(
          devices.filter((device) => device.publicKey === other.publicKey),
          2,
        ),
      ),
    )
    expect(store.get(grant.id, owner.publicKey)).toBeUndefined()
    expect(store.list().find((item) => item.id === grant.id)).toMatchObject({
      version: grant.version + 1,
      revokedAt: expect.any(Number),
    })
    expect(store.get(otherGrant.id, other.publicKey)).toBeDefined()
    const reopened = await DeviceGrants.load(filename)
    try {
      expect(reopened.accountTrust()).toMatchObject({ acceptedSequence: 2 })
      expect(reopened.get(grant.id, owner.publicKey)).toBeUndefined()
      await expect(reopened.acceptRoster(hubURL, await DeviceRoster.sign(owner, roster(devices, 3)))).rejects.toThrow(
        "locally trusted",
      )
    } finally {
      await reopened.close()
    }
  }))
test("concurrent writers cannot accept conflicting snapshots at the same sequence", () =>
  fixture(async (store, filename) => {
    const owner = await SecureChannel.createIdentity()
    await bind(store, owner)
    const other = await DeviceGrants.load(filename)
    try {
      const signed = await DeviceRoster.sign(
        owner,
        roster([{ publicKey: owner.publicKey, label: "Owner", signer: true, addedAt: 0 }], 1),
      )
      const results = await Promise.allSettled([store.acceptRoster(hubURL, signed), other.acceptRoster(hubURL, signed)])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(store.accountTrust()?.acceptedSequence).toBe(1)
    } finally {
      await other.close()
    }
  }))
