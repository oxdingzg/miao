export * as HubTickets from "./hub-tickets"

import { createHash, randomBytes } from "node:crypto"
import type { HubAuth } from "./hub-auth"

type Entry = {
  principal: HubAuth.Principal
  hostID: string
  runtimeID: string
  expiresAt: number
}
type Options = { clock?: () => number; maxPending?: number; maxPerAccount?: number }

/** One-use, role-bound browser upgrade credentials. Only hashes remain in memory. */
export function make(options: Options = {}) {
  const entries = new Map<string, Entry>()
  const now = options.clock ?? Date.now
  const limits = { global: options.maxPending ?? 4096, account: options.maxPerAccount ?? 32 }
  if (!Number.isInteger(limits.global) || limits.global < 1 || !Number.isInteger(limits.account) || limits.account < 1)
    throw new Error("Invalid browser ticket limits")
  function prune() {
    const time = now()
    entries.forEach((entry, key) => {
      if (entry.expiresAt <= time) entries.delete(key)
    })
  }
  return {
    issue: (principal: HubAuth.Principal, hostID: string, runtimeID: string) => {
      prune()
      if (
        principal.expiresAt <= now() ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(hostID) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(runtimeID) ||
        entries.size >= limits.global ||
        [...entries.values()].filter((entry) => entry.principal.accountID === principal.accountID).length >=
          limits.account
      )
        return undefined
      const ticket = randomBytes(32).toString("base64url")
      const expiresAt = Math.min(now() + 30_000, principal.expiresAt)
      entries.set(hash(ticket), { principal: { ...principal }, hostID, runtimeID, expiresAt })
      return { ticket, expiresAt }
    },
    consume: (ticket: string, hostID: string) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return undefined
      const key = hash(ticket)
      const entry = entries.get(key)
      // A valid nonce is spent even when the caller attempts the wrong route.
      entries.delete(key)
      return entry && entry.hostID === hostID && entry.expiresAt > now() ? entry : undefined
    },
    clear: () => entries.clear(),
  }
}

function hash(ticket: string) {
  return createHash("sha256").update(ticket).digest("hex")
}
