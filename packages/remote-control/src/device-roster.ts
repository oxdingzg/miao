export * as DeviceRoster from "./device-roster"

import { Schema } from "effect"
import { SecureChannel } from "./secure-channel"

const encoded = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const AccountID = encoded.check(Schema.isLengthBetween(16, 128))
export const Device = Schema.Struct({
  publicKey: encoded.check(Schema.isLengthBetween(87, 87)),
  label: Schema.String.check(Schema.isLengthBetween(1, 128)),
  signer: Schema.Boolean,
  addedAt: integer,
})
export const Roster = Schema.Struct({
  version: Schema.Literal(1),
  accountID: AccountID,
  sequence: integer.check(Schema.isGreaterThanOrEqualTo(1)),
  issuedAt: integer,
  devices: Schema.Array(Device).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
export type Roster = typeof Roster.Type
export type Device = typeof Device.Type
export const Signed = Schema.Struct({
  version: Schema.Literal(1),
  roster: Roster,
  signature: encoded.check(Schema.isLengthBetween(86, 86)),
})
export type Signed = typeof Signed.Type
export type Authority = {
  readonly accountID: string
  readonly acceptedSequence: number
  readonly signerKeys: ReadonlyArray<string>
}

/** Device timestamps are display metadata, not an authorization clock. */
async function validate(input: unknown): Promise<Roster> {
  const roster = structuredClone(Schema.decodeUnknownSync(Roster, { onExcessProperty: "error" })(input))
  let previous = ""
  for (const device of roster.devices) {
    if (device.publicKey <= previous) throw new Error("Roster device keys must be unique and sorted")
    previous = device.publicKey
    await importKey(device.publicKey)
  }
  return roster
}

export async function sign(identity: SecureChannel.Identity, input: Roster): Promise<Signed> {
  const roster = await validate(input)
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.keys.privateKey,
    bytes(roster),
  )
  return {
    version: 1,
    roster: JSON.parse(SecureChannel.canonicalJSON(roster)) as Roster,
    signature: encode(new Uint8Array(signature)),
  }
}

/** Authority must come from the previously accepted local state, never this payload. */
export async function accept(input: unknown, authority: Authority): Promise<Signed & { digest: string }> {
  if (typeof input === "string" && new TextEncoder().encode(input).length > 65536)
    throw new Error("Roster exceeds size limit")
  const signed = Schema.decodeUnknownSync(Signed, { onExcessProperty: "error" })(
    typeof input === "string" ? JSON.parse(input) : input,
  )
  const roster = await validate(signed.roster)
  if (roster.accountID !== authority.accountID) throw new Error("Roster account mismatch")
  if (
    !Number.isSafeInteger(authority.acceptedSequence) ||
    authority.acceptedSequence < 0 ||
    roster.sequence <= authority.acceptedSequence
  )
    throw new Error("Roster sequence did not advance")
  const signature = decode(signed.signature, 64)
  const data = bytes(roster)
  let trusted = false
  for (const key of authority.signerKeys) {
    if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(key), signature, data)) {
      trusted = true
      break
    }
  }
  if (!trusted) throw new Error("Roster signer is not locally trusted")
  const digest = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
  return { version: 1, roster, signature: signed.signature, digest }
}

function bytes(roster: Roster) {
  return new TextEncoder().encode(SecureChannel.canonicalJSON(["miao.control.roster.v1", roster]))
}
function encode(value: Uint8Array<ArrayBuffer>): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}
function decode(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid roster binary encoding")
  const result = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
  if (result.length !== length || encode(result) !== value) throw new Error("Invalid roster binary encoding")
  return result
}
async function importKey(value: string): Promise<CryptoKey> {
  const raw = decode(value, 65)
  if (raw[0] !== 4) throw new Error("Invalid roster device key")
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
}
