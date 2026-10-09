export * as HostEndorsement from "./host-endorsement"

import { Schema } from "effect"
import { DeviceRoster } from "./device-roster"
import { SecureChannel } from "./secure-channel"

const encoded = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const key = encoded.check(Schema.isLengthBetween(87, 87))
const Host = Schema.Struct({ hostID: DeviceRoster.AccountID, publicKey: key })
const Payload = Schema.Struct({
  version: Schema.Literal(1),
  hubURL: Schema.String,
  accountID: DeviceRoster.AccountID,
  deviceKey: key,
  challenge: encoded.check(Schema.isLengthBetween(43, 43)),
  hosts: Schema.Array(Host).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
export type Payload = typeof Payload.Type
const Signed = Schema.Struct({ payload: Payload, signature: encoded.check(Schema.isLengthBetween(86, 86)) })
export type Signed = typeof Signed.Type
export type Expected = Pick<Payload, "hubURL" | "accountID" | "deviceKey" | "challenge"> & {
  readonly trustedSignerKey: string
}

/** A signing device may endorse only host keys it independently paired with. */
export async function sign(identity: SecureChannel.Identity, input: Payload): Promise<Signed> {
  const payload = await validate(input)
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.keys.privateKey,
    bytes(payload),
  )
  return {
    payload: JSON.parse(SecureChannel.canonicalJSON(payload)) as Payload,
    signature: encode(new Uint8Array(signature)),
  }
}

/** trustedSignerKey is obtained out of band from the approving device, not the Hub. */
export async function accept(input: unknown, expected: Expected): Promise<Payload> {
  const signed = Schema.decodeUnknownSync(Signed, { onExcessProperty: "error" })(input)
  const payload = await validate(signed.payload)
  if (
    payload.hubURL !== origin(expected.hubURL) ||
    payload.accountID !== expected.accountID ||
    payload.deviceKey !== expected.deviceKey ||
    payload.challenge !== expected.challenge
  )
    throw new Error("Host endorsement does not match this enrollment")
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importKey(expected.trustedSignerKey),
      decode(signed.signature, 64),
      bytes(payload),
    ))
  )
    throw new Error("Host endorsement signer is not independently trusted")
  return payload
}

async function validate(input: unknown): Promise<Payload> {
  const payload = structuredClone(Schema.decodeUnknownSync(Payload, { onExcessProperty: "error" })(input))
  if (payload.hubURL !== origin(payload.hubURL)) throw new Error("Non-canonical host endorsement origin")
  decode(payload.challenge, 32)
  await importKey(payload.deviceKey)
  let previous = ""
  for (const host of payload.hosts) {
    if (host.hostID <= previous) throw new Error("Endorsed hosts must be unique and sorted")
    previous = host.hostID
    await importKey(host.publicKey)
  }
  return payload
}
function origin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Invalid host endorsement Hub")
  return url.origin
}
function bytes(payload: Payload) {
  return new TextEncoder().encode(SecureChannel.canonicalJSON(["miao.control.host-endorsement.v1", payload]))
}
function encode(value: Uint8Array<ArrayBuffer>): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}
function decode(value: string, size: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid host endorsement encoding")
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
  if (bytes.length !== size || encode(bytes) !== value) throw new Error("Invalid host endorsement encoding")
  return bytes
}
async function importKey(value: string) {
  const raw = decode(value, 65)
  if (raw[0] !== 4) throw new Error("Invalid endorsed identity")
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
}
