export * as ControlPairing from "./pairing"

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { DeviceGrants } from "./grants"
import { SecureChannel } from "./secure-channel"

const Claim = Schema.Struct({
  pairingID: Schema.String,
  label: Schema.String.check(Schema.isLengthBetween(1, 128)),
  proof: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  hello: Schema.Unknown,
})
export type Policy = Pick<DeviceGrants.Grant, "permissions" | "projectIDs" | "sessionIDs" | "expiresAt">
export type Invitation = {
  version: 1
  pairingID: string
  secret: string
  hubURL: string
  hostID: string
  runtimeID: string
  hostPublicKey: string
  expiresAt: number
}
type Pending = {
  invitation: Invitation
  policy: Policy
  attempts: number
  consumed: boolean
  candidate?: { publicKey: string; label: string; clientChallenge: string }
  resolve?: (grant: DeviceGrants.Grant) => void
  reject?: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Local administration creates and approves invitations. Possessing the QR
 * secret proves association with a flow; it never grants Session access itself. */
export function make(options: { grants: DeviceGrants.Store; target: SecureChannel.Target; hubURL: string }) {
  const pending = new Map<string, Pending>()
  const writes = new Set<Promise<DeviceGrants.Grant>>()
  const state = { closed: false }
  function remove(id: string) {
    const item = pending.get(id)
    if (!item) return
    pending.delete(id)
    clearTimeout(item.timer)
    item.reject?.(new Error("Pairing unavailable"))
  }
  return {
    issue: (policy: Policy, lifetimeMs = 180000): Invitation => {
      if (state.closed) throw new Error("Pairing unavailable")
      pending.forEach((item, id) => {
        if (item.invitation.expiresAt <= Date.now()) remove(id)
      })
      if (
        pending.size >= 8 ||
        !Number.isSafeInteger(lifetimeMs) ||
        lifetimeMs < 1 ||
        lifetimeMs > 180000 ||
        !policy.permissions.length ||
        (!policy.projectIDs.length && !policy.sessionIDs.length) ||
        policy.expiresAt <= Date.now() ||
        policy.expiresAt > Date.now() + 365 * 86400000
      )
        throw new Error("Invalid pairing policy or invitation limit")
      const invitation: Invitation = {
        version: 1,
        pairingID: crypto.randomUUID(),
        secret: randomBytes(32).toString("hex"),
        hubURL: options.hubURL,
        ...options.target,
        hostPublicKey: options.grants.identity.publicKey,
        expiresAt: Math.min(Date.now() + lifetimeMs, policy.expiresAt),
      }
      pending.set(invitation.pairingID, { invitation, policy: structuredClone(policy), attempts: 0, consumed: false })
      return structuredClone(invitation)
    },
    claim: async (input: unknown, connectionID: string) => {
      if (state.closed) throw new Error("Pairing unavailable")
      const decoded = Schema.decodeUnknownOption(Claim, { onExcessProperty: "error" })(input)
      if (Option.isNone(decoded)) throw new Error("Pairing unavailable")
      const request = decoded.value
      const item = pending.get(request.pairingID)
      if (!item || item.consumed || item.invitation.expiresAt <= Date.now() || ++item.attempts > 10)
        throw new Error("Pairing unavailable")
      const expected = proof(item.invitation, request.label, request.hello)
      if (!timingSafeEqual(Buffer.from(request.proof, "hex"), Buffer.from(expected, "hex")))
        throw new Error("Pairing unavailable")
      const hello = request.hello
      if (!hello || typeof hello !== "object" || !("signingKey" in hello) || typeof hello.signingKey !== "string")
        throw new Error("Pairing unavailable")
      const accepted = await SecureChannel.acceptClient(
        options.grants.identity,
        options.target,
        connectionID,
        hello,
        hello.signingKey,
      )
      // Reserve only after proof/signature checks, then fence concurrent claims.
      if (state.closed || item.consumed || pending.get(request.pairingID) !== item)
        throw new Error("Pairing unavailable")
      item.consumed = true
      item.candidate = {
        publicKey: hello.signingKey,
        label: request.label,
        clientChallenge: accepted.hello.clientChallenge,
      }
      const result = new Promise<DeviceGrants.Grant>((resolve, reject) => {
        item.resolve = resolve
        item.reject = reject
      })
      // An immediately disconnected caller may never await this promise.
      void result.catch(() => undefined)
      item.timer = setTimeout(() => remove(request.pairingID), Math.max(1, item.invitation.expiresAt - Date.now()))
      return { ...accepted, pairingID: request.pairingID, result }
    },
    list: () =>
      Array.from(pending.values())
        .filter((item) => item.candidate && item.invitation.expiresAt > Date.now())
        .map((item) => ({
          pairingID: item.invitation.pairingID,
          candidate: structuredClone(item.candidate!),
          policy: structuredClone(item.policy),
          expiresAt: item.invitation.expiresAt,
        })),
    approve: async (pairingID: string, publicKey: string) => {
      const item = pending.get(pairingID)
      if (
        state.closed ||
        !item?.candidate ||
        item.candidate.publicKey !== publicKey ||
        item.invitation.expiresAt <= Date.now()
      )
        throw new Error("Pairing unavailable")
      // Consume the local approval before awaiting durable grant persistence.
      pending.delete(pairingID)
      clearTimeout(item.timer)
      const approval = options.grants.approve({ publicKey, label: item.candidate.label, ...item.policy })
      writes.add(approval)
      try {
        const grant = await approval
        item.resolve?.(grant)
        return grant
      } catch (error) {
        item.reject?.(new Error("Pairing unavailable"))
        throw error
      } finally {
        writes.delete(approval)
      }
    },
    reject: remove,
    stop: async () => {
      state.closed = true
      Array.from(pending.keys()).forEach(remove)
      await Promise.allSettled(Array.from(writes))
    },
  }
}

/** Canonical transcript binds the QR secret to the signed device challenge and
 * exact target. The secret itself is never sent to the Hub. */
export function proof(invitation: Invitation, label: string, hello: unknown) {
  return createHmac("sha256", Buffer.from(invitation.secret, "hex"))
    .update(SecureChannel.canonicalJSON(["miao.control.pair.v1", invitation.pairingID, label, hello]))
    .digest("hex")
}
