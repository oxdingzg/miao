import { expect, test } from "bun:test"
import { PairingProof } from "../src/pairing-proof"
import { ControlPairing } from "../src/pairing"
import { SecureChannel } from "../src/secure-channel"

test("browser proof matches the Agent transcript without disclosing the QR secret", async () => {
  const target = { hostID: "host_browser_proof_01", runtimeID: "runtime_browser_proof_01" }
  const device = await SecureChannel.createIdentity({ extractable: false })
  const host = await SecureChannel.createIdentity()
  const { hello } = await SecureChannel.startClient(device, target)
  const invitation = { version: 1 as const, pairingID: "pair_browser_proof_01", secret: "a1".repeat(32),
    hubURL: "https://relay.example.invalid", ...target, hostPublicKey: host.publicKey, expiresAt: Date.now() + 60000 }
  const claim = await PairingProof.claim(invitation, "浏览器", hello)
  expect(claim.proof).toBe(ControlPairing.proof(invitation, "浏览器", hello))
  expect(JSON.stringify(claim)).not.toContain(invitation.secret)
  await expect(PairingProof.claim({ ...invitation, runtimeID: "runtime_different_01" }, "浏览器", hello)).rejects.toThrow()
  await expect(PairingProof.claim({ ...invitation, expiresAt: 0 }, "浏览器", hello)).rejects.toThrow()
})
