export * as PushContext from "./push-context"

import { SecureChannel } from "./secure-channel"
import { Schema } from "effect"

export type Binding = {
  hostID: string
  runtimeID: string
  grantID: string
  grantVersion: number
  deviceID: string
  signalID: string
}
export type Payload = { sessionID: string; projectID: string; expiresAt: number }
const Payload = Schema.Struct({ sessionID: Schema.String, projectID: Schema.String, expiresAt: Schema.Number })
const domain = new TextEncoder().encode("miao.push.context.v1\u0000")

/** A one-shot signed, device-encrypted hint; it cannot authorize or execute a session operation. */
export async function seal(host: SecureChannel.Identity, binding: Binding, payload: Payload) {
  const associated = routing(binding)
  validatePayload(payload)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const peer = await crypto.subtle.importKey(
    "raw",
    decode(binding.deviceID, 65),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const header = concat(new Uint8Array([1]), publicKey, nonce)
  const key = await derive(ephemeral.privateKey, peer, associated)
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: concat(domain, associated, header) },
      key,
      plaintext,
    ),
  )
  const body = concat(header, encrypted)
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      host.keys.privateKey,
      concat(domain, associated, body),
    ),
  )
  return encode(concat(body, signature))
}

export async function open(
  device: SecureChannel.Identity,
  pinnedHostKey: string,
  binding: Binding,
  context: string,
): Promise<Payload> {
  if (device.publicKey !== binding.deviceID) throw new Error("Push device mismatch")
  const associated = routing(binding)
  const packet = decode(context)
  if (packet.length < 158 || packet[0] !== 1) throw new Error("Invalid push context")
  const body = packet.subarray(0, packet.length - 64)
  const signature = packet.subarray(packet.length - 64)
  const signingKey = await crypto.subtle.importKey(
    "raw",
    decode(pinnedHostKey, 65),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      signature,
      concat(domain, associated, body),
    ))
  )
    throw new Error("Untrusted push context")
  const peer = await crypto.subtle.importKey(
    "raw",
    body.subarray(1, 66),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const exported = await crypto.subtle.exportKey("jwk", device.keys.privateKey)
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, d: exported.d },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )
  const key = await derive(privateKey, peer, associated)
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: body.subarray(66, 78), additionalData: concat(domain, associated, body.subarray(0, 78)) },
    key,
    body.subarray(78),
  )
  const payload = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Payload)), {
    onExcessProperty: "error",
  })(new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
  validatePayload(payload)
  return payload
}

async function derive(privateKey: CryptoKey, peer: CryptoKey, associated: Uint8Array<ArrayBuffer>) {
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256)
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: await crypto.subtle.digest("SHA-256", associated), info: domain },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}
function routing(binding: Binding) {
  for (const id of [binding.hostID, binding.runtimeID, binding.grantID, binding.signalID])
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error("Invalid push routing identity")
  decode(binding.deviceID, 65)
  if (!Number.isSafeInteger(binding.grantVersion) || binding.grantVersion < 1)
    throw new Error("Invalid push grant version")
  return new TextEncoder().encode(
    JSON.stringify([
      binding.hostID,
      binding.runtimeID,
      binding.grantID,
      binding.grantVersion,
      binding.deviceID,
      binding.signalID,
    ]),
  )
}
function validatePayload(payload: Payload) {
  if (
    ![payload.sessionID, payload.projectID].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= Date.now() ||
    payload.expiresAt > Date.now() + 600_000
  )
    throw new Error("Invalid or expired push payload")
}
function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  parts.reduce((offset, part) => {
    output.set(part, offset)
    return offset + part.length
  }, 0)
  return output
}
function encode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}
function decode(value: string, length?: number) {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid push encoding")
  const bytes = new Uint8Array(Buffer.from(value, "base64url"))
  if (encode(bytes) !== value || (length !== undefined && bytes.length !== length))
    throw new Error("Invalid push encoding")
  return bytes
}
