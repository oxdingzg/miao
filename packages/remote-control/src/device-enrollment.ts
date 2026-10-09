export * as DeviceEnrollment from "./device-enrollment"

import { Schema } from "effect"
import { DeviceRoster } from "./device-roster"
import { HostEndorsement } from "./host-endorsement"
import { SecureChannel } from "./secure-channel"

const encoded = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Payload = Schema.Struct({
  version: Schema.Literal(1),
  hubURL: Schema.String,
  accountID: DeviceRoster.AccountID,
  publicKey: encoded.check(Schema.isLengthBetween(87, 87)),
  challenge: encoded.check(Schema.isLengthBetween(43, 43)),
  label: Schema.String.check(Schema.isLengthBetween(1, 128)),
  createdAt: integer,
  expiresAt: integer,
})
export const Request = Schema.Struct({ payload: Payload, signature: encoded.check(Schema.isLengthBetween(86, 86)) })
export type Request = typeof Request.Type
export type Binding = { hubURL: string; accountID: string; allowLoopbackHTTP?: boolean }
export type Authority = DeviceRoster.Authority & { acceptedDigest: string }
export type Approval = { version: 1; roster: DeviceRoster.Signed; endorsement: HostEndorsement.Signed }
const Approval = Schema.Struct({
  version: Schema.Literal(1),
  roster: DeviceRoster.Signed,
  endorsement: Schema.Struct({ payload: Schema.Unknown, signature: Schema.String }),
})

/** A fresh, ten-minute proof of possession, transferred directly to a trusted signing device. */
export async function request(
  identity: SecureChannel.Identity,
  binding: Binding,
  label: string,
  now = Date.now(),
): Promise<Request> {
  const payload = Schema.decodeUnknownSync(Payload)({
    version: 1,
    hubURL: origin(binding.hubURL, binding.allowLoopbackHTTP),
    accountID: binding.accountID,
    publicKey: identity.publicKey,
    label,
    challenge: encode(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: now,
    expiresAt: now + 600000,
  })
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.keys.privateKey,
    bytes(payload),
  )
  return { payload, signature: encode(new Uint8Array(signature)) }
}

/** Local authority and paired host keys must come from durable independent trust, never Hub metadata. */
export async function approve(
  identity: SecureChannel.Identity,
  input: unknown,
  options: Binding & {
    current: DeviceRoster.Signed
    authority: Authority
    hosts: HostEndorsement.Payload["hosts"]
    now?: number
  },
): Promise<Approval> {
  const trusted = structuredClone(options)
  const requested = await verify(input, trusted, trusted.now ?? Date.now())
  if (
    trusted.authority.accountID !== trusted.accountID ||
    trusted.current.roster.accountID !== trusted.accountID ||
    trusted.current.roster.sequence !== trusted.authority.acceptedSequence ||
    (await DeviceRoster.fingerprint(trusted.current.roster)) !== trusted.authority.acceptedDigest ||
    !trusted.authority.signerKeys.includes(identity.publicKey) ||
    !trusted.current.roster.devices.some((device) => device.publicKey === identity.publicKey && device.signer)
  )
    throw new Error("Enrollment requires locally accepted signer authority")
  const member = trusted.current.roster.devices.find((device) => device.publicKey === requested.payload.publicKey)
  const devices = member
    ? [...trusted.current.roster.devices]
    : [
        ...trusted.current.roster.devices,
        {
          publicKey: requested.payload.publicKey,
          label: requested.payload.label,
          signer: false,
          addedAt: trusted.now ?? Date.now(),
        },
      ]
  devices.sort((a, b) => (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0))
  const roster = await DeviceRoster.sign(identity, {
    ...trusted.current.roster,
    sequence: trusted.authority.acceptedSequence + 1,
    issuedAt: trusted.now ?? Date.now(),
    devices,
  })
  const endorsement = await HostEndorsement.sign(
    identity,
    {
      version: 1,
      hubURL: origin(trusted.hubURL, trusted.allowLoopbackHTTP),
      accountID: trusted.accountID,
      deviceKey: requested.payload.publicKey,
      challenge: requested.payload.challenge,
      hosts: trusted.hosts,
    },
    { allowLoopbackHTTP: trusted.allowLoopbackHTTP },
  )
  return { version: 1, roster, endorsement }
}

/** The signer key is obtained directly from the approving device over an out-of-band channel. */
export async function receive(
  input: unknown,
  pending: Request,
  trustedSignerKey: string,
  now = Date.now(),
  options: { allowLoopbackHTTP?: boolean } = {},
) {
  const approval = structuredClone(Schema.decodeUnknownSync(Approval, { onExcessProperty: "error" })(input))
  const requested = await verify(pending, { ...pending.payload, allowLoopbackHTTP: options.allowLoopbackHTTP }, now)
  const accepted = await DeviceRoster.accept(approval.roster, {
    accountID: requested.payload.accountID,
    acceptedSequence: 0,
    signerKeys: [trustedSignerKey],
  })
  if (!accepted.roster.devices.some((device) => device.publicKey === requested.payload.publicKey))
    throw new Error("Enrollment roster does not include this device")
  const endorsement = await HostEndorsement.accept(approval.endorsement, {
    hubURL: requested.payload.hubURL,
    accountID: requested.payload.accountID,
    deviceKey: requested.payload.publicKey,
    challenge: requested.payload.challenge,
    trustedSignerKey,
    allowLoopbackHTTP: options.allowLoopbackHTTP,
  })
  return {
    roster: accepted,
    hosts: endorsement.hosts,
    authority: {
      accountID: accepted.roster.accountID,
      acceptedSequence: accepted.roster.sequence,
      acceptedDigest: accepted.digest,
      signerKeys: accepted.roster.devices.filter((device) => device.signer).map((device) => device.publicKey),
    },
  }
}

/** Tab-local nonce consumption and cancellation fence, including asynchronous signature verification. */
export function make(identity: SecureChannel.Identity, binding: Binding) {
  const expected = { ...binding, hubURL: origin(binding.hubURL, binding.allowLoopbackHTTP) }
  let epoch = 0
  let pending: Request | undefined
  let busy = false
  return {
    cancel: () => {
      epoch++
      pending = undefined
    },
    begin: async (label: string) => {
      const current = ++epoch
      pending = undefined
      const candidate = await request(identity, expected, label)
      if (epoch !== current) throw new Error("Enrollment changed")
      pending = candidate
      return structuredClone(candidate)
    },
    receive: async (input: unknown, trustedSignerKey: string) => {
      if (!pending || busy) throw new Error("No pending enrollment")
      const current = epoch
      const candidate = pending
      busy = true
      try {
        const accepted = await receive(input, candidate, trustedSignerKey, Date.now(), {
          allowLoopbackHTTP: binding.allowLoopbackHTTP,
        })
        if (epoch !== current || pending !== candidate || candidate.payload.expiresAt <= Date.now())
          throw new Error("Enrollment changed or expired")
        pending = undefined
        epoch++
        return accepted
      } finally {
        busy = false
      }
    },
  }
}

async function verify(input: unknown, binding: Binding, now: number): Promise<Request> {
  const requested = structuredClone(Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(input))
  const payload = requested.payload
  if (
    payload.hubURL !== origin(binding.hubURL, binding.allowLoopbackHTTP) ||
    payload.accountID !== binding.accountID ||
    payload.expiresAt <= now ||
    payload.createdAt > now + 30000 ||
    payload.expiresAt <= payload.createdAt ||
    payload.expiresAt - payload.createdAt > 600000
  )
    throw new Error("Enrollment request is expired or bound to another account")
  decode(payload.challenge, 32)
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importKey(payload.publicKey),
      decode(requested.signature, 64),
      bytes(payload),
    ))
  )
    throw new Error("Enrollment request proof of possession is invalid")
  return requested
}
function bytes(payload: typeof Payload.Type) {
  return new TextEncoder().encode(SecureChannel.canonicalJSON(["miao.control.enrollment.v1", payload]))
}
function origin(value: string, allowLoopbackHTTP = false) {
  const url = new URL(value)
  const loopback =
    allowLoopbackHTTP && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid enrollment Hub")
  return url.origin
}
function encode(value: Uint8Array<ArrayBuffer>) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}
function decode(value: string, length: number) {
  const raw = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
  if (raw.length !== length || encode(raw) !== value) throw new Error("Invalid enrollment encoding")
  return raw
}
async function importKey(value: string) {
  const raw = decode(value, 65)
  if (raw[0] !== 4) throw new Error("Invalid enrollment device key")
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
}
