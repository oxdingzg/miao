export * as RuntimeIdentity from "./runtime-identity"

import { Schema } from "effect"

export const Challenge = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).annotate({
  identifier: "RuntimeIdentity.Challenge",
})

export interface Proof extends Schema.Schema.Type<typeof Proof> {}
export const Proof = Schema.Struct({
  runtimeID: Schema.String.check(Schema.isUUID(4)),
  version: Schema.String.check(Schema.isMaxLength(128)),
  protocol: Schema.Literal(1),
  storageID: Challenge,
  url: Schema.String.check(Schema.isMaxLength(256)),
  proof: Challenge,
}).annotate({ identifier: "RuntimeIdentity.Proof" })
