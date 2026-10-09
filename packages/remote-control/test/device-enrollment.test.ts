import { expect, test } from "bun:test"
import { DeviceEnrollment } from "../src/device-enrollment"
import { DeviceRoster } from "../src/device-roster"
import { SecureChannel } from "../src/secure-channel"

const binding = { hubURL: "https://relay.example.invalid", accountID: "account_aaaaaaaaaaaaaaaaaaaaaaaa" }
async function fixture() {
  const root = await SecureChannel.createIdentity()
  const recipient = await SecureChannel.createIdentity()
  const host = await SecureChannel.createIdentity()
  const current = await DeviceRoster.sign(root, {
    version: 1,
    accountID: binding.accountID,
    sequence: 1,
    issuedAt: 0,
    devices: [{ publicKey: root.publicKey, label: "Root", signer: true, addedAt: 0 }],
  })
  const authority = {
    accountID: binding.accountID,
    acceptedSequence: 1,
    acceptedDigest: await DeviceRoster.fingerprint(current.roster),
    signerKeys: [root.publicKey],
  }
  const options = {
    ...binding,
    current,
    authority,
    hosts: [{ hostID: "host_aaaaaaaaaaaaaaaaaaaaaaaa", publicKey: host.publicKey }],
  }
  return { root, recipient, options }
}

test("Signed enrollment binds recipient proof, independent signer pin and endorsed host identities", async () => {
  const { root, recipient, options } = await fixture()
  const enrollment = DeviceEnrollment.make(recipient, binding)
  const request = await enrollment.begin("Phone")
  const approved = await DeviceEnrollment.approve(root, request, options)
  const accepted = await enrollment.receive(approved, root.publicKey)
  expect(accepted.authority.acceptedSequence).toBe(2)
  expect(accepted.hosts).toEqual(options.hosts)
  expect(accepted.roster.roster.devices.find((device) => device.publicKey === recipient.publicKey)?.signer).toBe(false)
  expect(accepted.authority.signerKeys).toEqual([root.publicKey])
  await expect(enrollment.receive(approved, root.publicKey)).rejects.toThrow("No pending")
})

test("Enrollment rejects intercepted requests, foreign accounts and unaccepted signer metadata", async () => {
  const { root, recipient, options } = await fixture()
  const request = await DeviceEnrollment.request(recipient, binding, "Phone")
  const fake = await SecureChannel.createIdentity()
  await expect(
    DeviceEnrollment.approve(root, { ...request, payload: { ...request.payload, publicKey: fake.publicKey } }, options),
  ).rejects.toThrow("proof")
  await expect(
    DeviceEnrollment.approve(root, request, { ...options, accountID: "account_bbbbbbbbbbbbbbbbbbbbbbbb" }),
  ).rejects.toThrow("another account")
  await expect(DeviceEnrollment.approve(fake, request, options)).rejects.toThrow("locally accepted")
  await expect(
    DeviceEnrollment.approve(root, request, {
      ...options,
      current: { ...options.current, roster: { ...options.current.roster, sequence: 2 } },
    }),
  ).rejects.toThrow("locally accepted")
  await expect(
    DeviceEnrollment.approve(root, request, {
      ...options,
      authority: { ...options.authority, acceptedDigest: "fake" },
    }),
  ).rejects.toThrow("locally accepted")
})

test("Enrollment rejects fake root, changed endorsement, stale nonce and late cancellation", async () => {
  const { root, recipient, options } = await fixture()
  const enrollment = DeviceEnrollment.make(recipient, binding)
  const request = await enrollment.begin("Phone")
  const approved = await DeviceEnrollment.approve(root, request, options)
  const fake = await SecureChannel.createIdentity()
  await expect(enrollment.receive(approved, fake.publicKey)).rejects.toThrow("not locally trusted")
  const modified = {
    ...approved,
    endorsement: {
      ...approved.endorsement,
      payload: { ...approved.endorsement.payload, hosts: [{ ...options.hosts[0]!, publicKey: fake.publicKey }] },
    },
  }
  await expect(enrollment.receive(modified, root.publicKey)).rejects.toThrow("not independently trusted")
  await enrollment.begin("New attempt")
  await expect(enrollment.receive(approved, root.publicKey)).rejects.toThrow("does not match")
  const next = await enrollment.begin("Final attempt")
  const nextApproved = await DeviceEnrollment.approve(root, next, options)
  const pending = enrollment.receive(nextApproved, root.publicKey)
  enrollment.cancel()
  await expect(pending).rejects.toThrow("changed")
  await expect(enrollment.receive(nextApproved, root.publicKey)).rejects.toThrow("No pending")
})

test("Proof expires and an existing member is not duplicated or silently promoted", async () => {
  const { root, recipient, options } = await fixture()
  const request = await DeviceEnrollment.request(recipient, binding, "Phone", 1000)
  await expect(DeviceEnrollment.approve(root, request, { ...options, now: 601000 })).rejects.toThrow("expired")
  const first = await DeviceEnrollment.approve(root, request, { ...options, now: 2000 })
  const authority = {
    ...options.authority,
    acceptedSequence: 2,
    acceptedDigest: await DeviceRoster.fingerprint(first.roster.roster),
  }
  const second = await DeviceEnrollment.approve(root, request, {
    ...options,
    now: 3000,
    current: first.roster,
    authority,
  })
  expect(second.roster.roster.devices).toHaveLength(2)
  expect(second.roster.roster.devices.find((device) => device.publicKey === recipient.publicKey)?.signer).toBe(false)
})

test("HTTP enrollment is restricted to explicit loopback development opt-in", async () => {
  const { root, recipient, options } = await fixture()
  const local = { ...binding, hubURL: "http://127.0.0.1:4600", allowLoopbackHTTP: true }
  await expect(DeviceEnrollment.request(recipient, { ...local, allowLoopbackHTTP: false }, "Phone")).rejects.toThrow(
    "Hub",
  )
  await expect(
    DeviceEnrollment.request(recipient, { ...local, hubURL: "http://relay.example.invalid" }, "Phone"),
  ).rejects.toThrow("Hub")
  const pending = await DeviceEnrollment.request(recipient, local, "Phone")
  const approved = await DeviceEnrollment.approve(root, pending, { ...options, ...local })
  await expect(DeviceEnrollment.receive(approved, pending, root.publicKey)).rejects.toThrow("Hub")
  const received = await DeviceEnrollment.receive(approved, pending, root.publicKey, Date.now(), {
    allowLoopbackHTTP: true,
  })
  expect(received.hosts).toEqual(options.hosts)
})
