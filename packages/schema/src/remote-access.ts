export * as RemoteAccess from "./remote-access"

import { Schema } from "effect"
import { optional } from "./schema"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
const PublicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/))
const ScopeID = Schema.String.check(Schema.isLengthBetween(1, 128))
export const Permission = Schema.Literals([
  "read",
  "prompt",
  "permission.reply",
  "question.reply",
  "interrupt",
  "session.create",
  "session.rename",
]).annotate({ identifier: "RemoteAccess.Permission" })
export type Permission = typeof Permission.Type
export interface Policy extends Schema.Schema.Type<typeof Policy> {}
export const Policy = Schema.Struct({
  permissions: Schema.Array(Permission).check(Schema.isLengthBetween(1, 16)),
  projectIDs: Schema.Array(ScopeID).check(Schema.isMaxLength(128)),
  sessionIDs: Schema.Array(ScopeID).check(Schema.isMaxLength(256)),
  expiresAt: Schema.Int,
}).annotate({ identifier: "RemoteAccess.Policy" })
export interface Grant extends Schema.Schema.Type<typeof Grant> {}
export const Grant = Schema.Struct({
  ...Policy.fields,
  id: ID,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  publicKey: PublicKey,
  label: Schema.String.check(Schema.isLengthBetween(1, 128)),
  createdAt: Schema.Int,
  revokedAt: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "RemoteAccess.Grant" })
export interface Invitation extends Schema.Schema.Type<typeof Invitation> {}
export const Invitation = Schema.Struct({
  version: Schema.Literal(1),
  pairingID: ID,
  secret: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  hubURL: Schema.String,
  hostID: ID,
  runtimeID: ID,
  hostPublicKey: PublicKey,
  expiresAt: Schema.Int,
}).annotate({ identifier: "RemoteAccess.Invitation" })
export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}
export const Candidate = Schema.Struct({
  pairingID: ID,
  candidate: Schema.Struct({ publicKey: PublicKey, label: Schema.String, clientChallenge: Schema.String }),
  policy: Policy,
  expiresAt: Schema.Int,
}).annotate({ identifier: "RemoteAccess.Candidate" })
export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  hostID: ID.pipe(optional),
  runtimeID: ID.pipe(optional),
  hostPublicKey: PublicKey.pipe(optional),
  hubURL: Schema.String.pipe(optional),
}).annotate({ identifier: "RemoteAccess.Status" })

export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}
export const Configuration = Schema.Struct({
  hubURL: Schema.String.check(Schema.isLengthBetween(1, 2048)),
  hostToken: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,256}$/)).pipe(Schema.redact),
}).annotate({ identifier: "RemoteAccess.Configuration" })
