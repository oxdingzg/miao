export * as PairingProof from "./pairing-proof"

import type { RemoteAccess } from "@miao/schema/remote-access"
import { SecureChannel } from "./secure-channel"

/** Browser-safe QR proof. Send the claim through the selected relay route; never send the invitation secret. */
export async function claim(invitation: RemoteAccess.Invitation, label: string, hello: SecureChannel.ClientHello) {
  if (!/^[a-f0-9]{64}$/.test(invitation.secret) || !label.length || label.length > 128 ||
      invitation.version !== 1 || invitation.expiresAt <= Date.now() ||
      hello.hostID !== invitation.hostID || hello.runtimeID !== invitation.runtimeID)
    throw new Error("Pairing invitation or target is invalid")
  const secret = Uint8Array.from(invitation.secret.match(/../g)!, (byte) => Number.parseInt(byte, 16))
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  secret.fill(0)
  const transcript = SecureChannel.canonicalJSON(["miao.control.pair.v1", invitation.pairingID, label, hello])
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(transcript))
  return { pairingID: invitation.pairingID, label, hello,
    proof: Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("") }
}
