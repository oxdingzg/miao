export * as BrowserEnrollment from "./browser-enrollment"

import { Schema } from "effect"
import { DeviceRoster } from "./device-roster"
import { DeviceEnrollment } from "./device-enrollment"

const Host = Schema.Struct({ hostID: DeviceRoster.AccountID, publicKey: Schema.String })
const State = Schema.Struct({
  version: Schema.Literal(1),
  hubURL: Schema.String,
  accountID: DeviceRoster.AccountID,
  deviceKey: Schema.String,
  roster: DeviceRoster.Signed,
  digest: Schema.String,
  hosts: Schema.Array(Host).check(Schema.isMaxLength(64)),
})
export type State = typeof State.Type
export type Binding = DeviceEnrollment.Binding & { deviceKey: string }

/** One atomic local record binds accepted authority and independently verified host pins. */
export function open(binding: Binding, authorized: () => boolean) {
  const expected = { ...binding }
  const key = JSON.stringify([
    "miao.remote-control.enrollment",
    expected.hubURL,
    expected.accountID,
    expected.deviceKey,
  ])
  const read = async () => {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    if (raw.length > 131072) throw new Error("Invalid local enrollment")
    return validate(JSON.parse(raw), expected)
  }
  const put = async (input: State) => {
    const next = await validate(structuredClone(input), expected)
    return navigator.locks.request(key, async () => {
      const current = await read()
      if (
        current &&
        (next.roster.roster.sequence < current.roster.roster.sequence ||
          (next.roster.roster.sequence === current.roster.roster.sequence && next.digest !== current.digest))
      )
        throw new Error("Local enrollment rollback or fork")
      if (!authorized()) throw new Error("Account changed")
      localStorage.setItem(key, JSON.stringify(next))
      return next
    })
  }
  return {
    read,
    put,
    refresh: async (input: DeviceRoster.Signed) =>
      navigator.locks.request(key, async () => {
        const signed = structuredClone(input)
        const current = await read()
        if (!current || !authorized()) throw new Error("Local enrollment required")
        const digest = await DeviceRoster.fingerprint(signed.roster)
        if (signed.roster.sequence === current.roster.roster.sequence) {
          if (digest !== current.digest) throw new Error("Roster fork")
          if (!authorized()) throw new Error("Account changed")
          return current
        }
        const accepted = await DeviceRoster.accept(signed, authority(current))
        const next = await validate({ ...current, roster: signed, digest: accepted.digest }, expected)
        if (!authorized()) throw new Error("Account changed")
        localStorage.setItem(key, JSON.stringify(next))
        return next
      }),
  }
}
export function authority(state: State): DeviceEnrollment.Authority {
  return {
    accountID: state.accountID,
    acceptedSequence: state.roster.roster.sequence,
    acceptedDigest: state.digest,
    signerKeys: state.roster.roster.devices.filter((device) => device.signer).map((device) => device.publicKey),
  }
}
export function update(roster: DeviceRoster.Signed) {
  return DeviceRoster.fingerprint(roster.roster).then((digest) => ({
    sequence: roster.roster.sequence,
    payload: roster.roster,
    signature: roster.signature,
    digest,
  }))
}
export async function snapshot(input: unknown, accountID: string): Promise<DeviceRoster.Signed | undefined> {
  if (!object(input) || !("roster" in input)) throw new Error("Invalid roster response")
  if (input.roster === null) return undefined
  const record = input.roster
  if (
    !object(record) ||
    record.accountID !== accountID ||
    !object(record.payload) ||
    record.sequence !== record.payload.sequence ||
    record.payload.accountID !== accountID ||
    typeof record.digest !== "string"
  )
    throw new Error("Roster account mismatch")
  const signed = Schema.decodeUnknownSync(DeviceRoster.Signed, { onExcessProperty: "error" })({
    version: 1,
    roster: record.payload,
    signature: record.signature,
  })
  if ((await DeviceRoster.fingerprint(signed.roster)) !== record.digest) throw new Error("Roster fingerprint mismatch")
  return structuredClone(signed)
}
async function validate(input: unknown, expected: Binding): Promise<State> {
  const state = structuredClone(Schema.decodeUnknownSync(State, { onExcessProperty: "error" })(input))
  if (
    state.hubURL !== expected.hubURL ||
    state.accountID !== expected.accountID ||
    state.deviceKey !== expected.deviceKey ||
    state.roster.roster.accountID !== expected.accountID ||
    !state.roster.roster.devices.some((device) => device.publicKey === expected.deviceKey) ||
    (await DeviceRoster.fingerprint(state.roster.roster)) !== state.digest
  )
    throw new Error("Invalid local enrollment binding")
  let previous = ""
  for (const host of state.hosts) {
    if (host.hostID <= previous) throw new Error("Invalid local host pins")
    previous = host.hostID
    await importKey(host.publicKey)
  }
  return state
}
async function importKey(value: string) {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error("Invalid local host key")
  const raw = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
  const canonical = btoa(Array.from(raw, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  if (raw.length !== 65 || raw[0] !== 4 || canonical !== value) throw new Error("Invalid local host key")
  await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
