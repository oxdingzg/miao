import { expect, test } from "bun:test"
import { DeviceRoster } from "../src/device-roster"
import { SecureChannel } from "../src/secure-channel"

const accountID = "account_" + "a".repeat(24)
async function fixture() {
  const owner = await SecureChannel.createIdentity()
  const other = await SecureChannel.createIdentity()
  const roster: DeviceRoster.Roster = {
    version: 1,
    accountID,
    sequence: 1,
    issuedAt: 0,
    devices: [{ publicKey: owner.publicKey, label: "Owner 手机", signer: true, addedAt: Number.MAX_SAFE_INTEGER }],
  }
  const authority = { accountID, acceptedSequence: 0, signerKeys: [owner.publicKey] }
  return { owner, other, roster, authority }
}
test("locally pinned signer authenticates canonical roster bytes regardless of object key order", async () => {
  const f = await fixture()
  const signed = await DeviceRoster.sign(f.owner, f.roster)
  const accepted = await DeviceRoster.accept(signed, f.authority)
  expect(accepted.digest).toHaveLength(43)
  expect(accepted.roster.issuedAt).toBe(0)
  const reordered = {
    ...signed,
    roster: { devices: signed.roster.devices, issuedAt: 0, sequence: 1, accountID, version: 1 as const },
  }
  expect((await DeviceRoster.accept(reordered, f.authority)).digest).toBe(accepted.digest)
})
test("a self-signed payload cannot nominate its own trusted signer", async () => {
  const f = await fixture()
  const attacker = { ...f.roster, devices: [{ ...f.roster.devices[0]!, publicKey: f.other.publicKey }] }
  await expect(DeviceRoster.accept(await DeviceRoster.sign(f.other, attacker), f.authority)).rejects.toThrow(
    "locally trusted",
  )
  await expect(
    DeviceRoster.accept(await DeviceRoster.sign(f.owner, f.roster), { ...f.authority, signerKeys: [] }),
  ).rejects.toThrow("locally trusted")
})
test("account substitution, stale snapshots and same-sequence forks are rejected", async () => {
  const f = await fixture()
  const signed = await DeviceRoster.sign(f.owner, f.roster)
  await expect(DeviceRoster.accept(signed, { ...f.authority, accountID: "account_" + "b".repeat(24) })).rejects.toThrow(
    "account mismatch",
  )
  for (const acceptedSequence of [1, 2])
    await expect(DeviceRoster.accept(signed, { ...f.authority, acceptedSequence })).rejects.toThrow("did not advance")
})
test("tampered labels or membership invalidate signatures", async () => {
  const f = await fixture()
  const signed = await DeviceRoster.sign(f.owner, f.roster)
  await expect(
    DeviceRoster.accept(
      { ...signed, roster: { ...signed.roster, devices: [{ ...signed.roster.devices[0], label: "changed" }] } },
      f.authority,
    ),
  ).rejects.toThrow("locally trusted")
})
test("strict structure, valid points, sorted unique keys and bounded integers are required", async () => {
  const f = await fixture()
  for (const input of [
    { ...f.roster, extra: true },
    { ...f.roster, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...f.roster, devices: [f.roster.devices[0]!, f.roster.devices[0]!] },
    { ...f.roster, devices: [{ ...f.roster.devices[0]!, publicKey: "a".repeat(87) }] },
    { ...f.roster, devices: [] },
    {
      ...f.roster,
      devices: [{ ...f.roster.devices[0]!, publicKey: f.other.publicKey }, f.roster.devices[0]!].sort((a, b) =>
        a.publicKey < b.publicKey ? 1 : -1,
      ),
    },
  ])
    await expect(DeviceRoster.sign(f.owner, input as DeviceRoster.Roster)).rejects.toThrow()
})

test("verification takes an immutable snapshot before asynchronous cryptographic work", async () => {
  const f = await fixture()
  const signed = JSON.parse(JSON.stringify(await DeviceRoster.sign(f.owner, f.roster)))
  const pending = DeviceRoster.accept(signed, f.authority)
  signed.roster.devices[0].label = "mutated while verifying"
  expect((await pending).roster.devices[0]?.label).toBe("Owner 手机")
})
