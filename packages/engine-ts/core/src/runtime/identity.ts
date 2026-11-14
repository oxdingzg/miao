export * as RuntimeIdentity from "./identity"

import { RuntimeIdentity } from "@miao/schema/runtime-identity"
import { Context, Schema } from "effect"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { RuntimeAdministration } from "./administration"

export interface Interface {
  readonly prove: (challenge: string) => RuntimeIdentity.Proof | undefined
  readonly stop?: () => void
  readonly administration?: () =>
    | RuntimeAdministration.Interface
    | undefined
    | Promise<RuntimeAdministration.Interface | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/core/RuntimeIdentity") {}

export type Identity = Interface & {
  readonly runtimeID: string
  readonly version: string
  readonly protocol: 1
  readonly storageID: string
  readonly bind: (url: string) => void
}

/** Storage must be the canonical path returned by RuntimeOwnership.acquire. */
export function create(storage: string, version: string, credential: string): Identity {
  if (credential.length < 32) throw new Error("Runtime identity requires a private random credential")
  const identity = {
    runtimeID: randomUUID(),
    version,
    protocol: 1 as const,
    storageID: createHash("sha256").update(storage).digest("hex"),
  }
  const state: { url?: string } = {}
  return {
    ...identity,
    bind: (input) => {
      const url = new URL(input)
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new Error("Runtime discovery requires a loopback HTTP listener")
      if (state.url) throw new Error("Runtime identity is already bound to a listener")
      state.url = url.href
    },
    prove: (challenge) => {
      Schema.decodeUnknownSync(RuntimeIdentity.Challenge)(challenge)
      if (!state.url) return undefined
      const bound = { ...identity, url: state.url }
      return { ...bound, proof: sign(bound, challenge, credential) }
    },
  }
}

export function verify(proof: RuntimeIdentity.Proof, challenge: string, credential: string): boolean {
  const expected = Buffer.from(sign(proof, challenge, credential), "hex")
  const actual = Buffer.from(proof.proof, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function sign(identity: Omit<RuntimeIdentity.Proof, "proof">, challenge: string, credential: string) {
  return createHmac("sha256", credential)
    .update(
      JSON.stringify([
        "miao.runtime.identity.v1",
        challenge,
        identity.runtimeID,
        identity.version,
        identity.protocol,
        identity.storageID,
        identity.url,
      ]),
    )
    .digest("hex")
}
