import { expect, test } from "bun:test"
import { PairingLink } from "../src/pairing-link"
import type { RemoteAccess } from "@miao/schema/remote-access"

const invitation = (): RemoteAccess.Invitation => ({
  version: 1,
  pairingID: "pair_" + "a".repeat(32),
  secret: "a".repeat(64),
  hubURL: "https://relay.example.invalid",
  hostID: "host_" + "a".repeat(32),
  runtimeID: crypto.randomUUID(),
  hostPublicKey: "a".repeat(87),
  expiresAt: Date.now() + 60000,
})
test("browser and native links round-trip the same short-lived invitation", () => {
  const value = invitation()
  for (const target of [undefined, "https://relay.example.invalid/control/"]) {
    const link = PairingLink.create(value, target)
    expect(PairingLink.parse(link, value.hubURL)).toEqual(value)
    expect(new URL(link).search).toBe("")
    if (target) expect(link.split("#")[0]).toBe(target)
  }
})
test("rejects foreign Hub links, credential URLs and expired invitations", () => {
  const value = invitation()
  expect(() => PairingLink.create(value, "https://other.example.invalid/")).toThrow()
  expect(() => PairingLink.create(value, "https://user:password@relay.example.invalid/")).toThrow()
  const link = PairingLink.create(value, "https://relay.example.invalid/control/")
  expect(() => PairingLink.parse(link.replace("relay.example", "other.example"))).toThrow()
  expect(() => PairingLink.parse(link, "https://other.example.invalid")).toThrow()
  expect(() => PairingLink.parse(PairingLink.create({ ...value, expiresAt: Date.now() - 1 }))).toThrow()
})
