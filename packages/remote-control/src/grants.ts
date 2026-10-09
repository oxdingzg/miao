export * as DeviceGrants from "./grants"

import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs"
import { openGrantLock } from "#grant-lock"
import { Option, Schema } from "effect"
import { DeviceRoster } from "./device-roster"
import { SecureChannel } from "./secure-channel"
import { RemoteAccess } from "@miao/schema/remote-access"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
export const Permission = RemoteAccess.Permission
export const Grant = RemoteAccess.Grant
export type Grant = RemoteAccess.Grant
export type Permission = RemoteAccess.Permission

const ScopeID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
const AccountPolicy = Schema.Struct({
  permissions: Schema.Array(Permission).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  projectIDs: Schema.Array(ScopeID).check(Schema.isMaxLength(1024)),
  sessionIDs: Schema.Array(ScopeID).check(Schema.isMaxLength(1024)),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
})
const AccountTrust = Schema.Struct({
  version: Schema.Literal(1),
  hubURL: Schema.String,
  accountID: DeviceRoster.AccountID,
  acceptedSequence: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  acceptedDigest: Schema.Union([Schema.Null, Schema.String]),
  devices: Schema.Array(DeviceRoster.Device).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  managedGrants: Schema.optional(
    Schema.Array(Schema.Struct({ publicKey: DeviceRoster.Device.fields.publicKey, grantID: Grant.fields.id })).check(
      Schema.isMaxLength(1024),
    ),
  ),
  policy: AccountPolicy,
})
export type AccountTrust = typeof AccountTrust.Type

const State = Schema.Struct({
  version: Schema.Literal(1),
  hostID: ID,
  privateKey: Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.String,
    y: Schema.String,
    d: Schema.String,
  }),
  grants: Schema.Array(Grant).check(Schema.isMaxLength(1024)),
  accountTrust: Schema.optional(AccountTrust),
})
type State = typeof State.Type
const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(State)))

/** Durable device identity is shared; each operation coordinates through an OS lock. */
export async function load(filename: string) {
  const initial = await locked(filename, async () => {
    const saved = await read(filename)
    if (saved) return saved
    const generated = await SecureChannel.createIdentity()
    const exported = await crypto.subtle.exportKey("jwk", generated.keys.privateKey)
    const created: State = {
      version: 1,
      hostID: crypto.randomUUID(),
      privateKey: { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y!, d: exported.d! },
      grants: [],
    }
    await persist(filename, created)
    return created
  })
  const identity = await importIdentity(initial.privateKey)
  const state = { tail: Promise.resolve(), available: true, accepting: true }
  function mutate<T>(update: (current: State) => { next: State; result: T } | Promise<{ next: State; result: T }>) {
    if (!state.accepting) return Promise.reject(new Error("Device grant storage closed"))
    const pending = state.tail.then(async () => {
      if (!state.available) throw new Error("Device grant storage unavailable")
      return locked(filename, async () => {
        const current = await read(filename)
        if (!current || current.hostID !== initial.hostID) throw new Error("Device identity changed")
        const updated = await update(current)
        await persist(filename, updated.next)
        return updated.result
      })
    })
    state.tail = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
  function readCurrent() {
    const current = readSync(filename)
    if (current.hostID !== initial.hostID) throw new Error("Device identity changed")
    return current
  }
  function active(publicKey: string, now = Date.now()) {
    if (!state.available) return []
    return readCurrent().grants.filter(
      (grant) => grant.publicKey === publicKey && grant.revokedAt === null && grant.expiresAt > now,
    )
  }
  return {
    close: async () => {
      state.accepting = false
      await state.tail
      state.available = false
    },
    hostID: initial.hostID,
    identity,
    list: () => structuredClone(readCurrent().grants),
    active: (publicKey: string) => structuredClone(active(publicKey)),
    get: (id: string, publicKey: string) => structuredClone(active(publicKey).find((grant) => grant.id === id)),
    accountTrust: () => structuredClone(readCurrent().accountTrust),
    /** Only a local owner may bind an account to an already approved, live device.
     * accountID comes from the host's authenticated Hub setup, never a device claim. */
    bindAccount: (input: {
      hubURL: string
      accountID: string
      grantID: string
      grantVersion: number
      policy: AccountTrust["policy"]
      allowLoopbackHTTP?: boolean
    }) =>
      mutate((current) => {
        if (current.accountTrust) throw new Error("Account already bound; local reset required")
        const origin = new URL(input.hubURL)
        if (
          (origin.protocol !== "https:" &&
            !(
              input.allowLoopbackHTTP &&
              origin.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
            )) ||
          origin.username ||
          origin.password ||
          origin.pathname !== "/" ||
          origin.search ||
          origin.hash
        )
          throw new Error("Invalid account Hub origin")
        const selected = current.grants.find(
          (grant) =>
            grant.id === input.grantID &&
            grant.version === input.grantVersion &&
            grant.revokedAt === null &&
            grant.expiresAt > Date.now(),
        )
        if (!selected) throw new Error("Account trust requires an approved live device")
        const policy = Schema.decodeUnknownSync(AccountPolicy, { onExcessProperty: "error" })(input.policy)
        if (
          (!policy.projectIDs.length && !policy.sessionIDs.length) ||
          policy.expiresAt <= Date.now() ||
          policy.expiresAt > Date.now() + 365 * 86400000
        )
          throw new Error("Invalid local account policy")
        const trust = Schema.decodeUnknownSync(AccountTrust, { onExcessProperty: "error" })({
          version: 1,
          hubURL: origin.origin,
          accountID: input.accountID,
          acceptedSequence: 0,
          acceptedDigest: null,
          devices: [
            { publicKey: selected.publicKey, label: selected.label, signer: true, addedAt: selected.createdAt },
          ],
          policy,
        })
        return { next: { ...current, accountTrust: trust }, result: structuredClone(trust) }
      }),
    /** Caller must verify possession of this device key before invoking enrollment. */
    authorizeRosterDevice: (hubURL: string, accountID: string, publicKey: string) =>
      mutate((current) => {
        const trust = current.accountTrust
        const member = trust?.devices.find((device) => device.publicKey === publicKey)
        if (
          !trust ||
          !member ||
          trust.accountID !== accountID ||
          new URL(hubURL).origin !== trust.hubURL ||
          trust.policy.expiresAt <= Date.now()
        )
          throw new Error("Device is not locally authorized by this account")
        const index = trust.managedGrants ?? []
        const mapping = index.find((entry) => entry.publicKey === publicKey)
        const existing = mapping
          ? current.grants.find((grant) => grant.id === mapping.grantID && grant.publicKey === publicKey)
          : undefined
        if (mapping && !existing) throw new Error("Managed grant state is inconsistent")
        const same =
          existing &&
          existing.revokedAt === null &&
          existing.expiresAt === trust.policy.expiresAt &&
          JSON.stringify(existing.permissions) === JSON.stringify(trust.policy.permissions) &&
          JSON.stringify(existing.projectIDs) === JSON.stringify(trust.policy.projectIDs) &&
          JSON.stringify(existing.sessionIDs) === JSON.stringify(trust.policy.sessionIDs)
        if (same) return { next: current, result: structuredClone(existing) }
        // Recycle a revoked matching-key row after a local reset; never overwrite an unrelated device.
        const previous =
          existing ?? current.grants.find((grant) => grant.publicKey === publicKey && grant.revokedAt !== null)
        if (!previous && current.grants.length >= 1024) throw new Error("Device grant limit reached")
        if (!mapping && index.length >= 1024) throw new Error("Managed device limit reached")
        const grant = Schema.decodeUnknownSync(Grant)({
          ...trust.policy,
          id: previous?.id ?? crypto.randomUUID(),
          version: previous ? previous.version + 1 : 1,
          publicKey,
          label: member.label,
          createdAt: Date.now(),
          revokedAt: null,
        })
        const managedGrants = mapping ? index : [...index, { publicKey, grantID: grant.id }]
        return {
          next: {
            ...current,
            accountTrust: { ...trust, managedGrants },
            grants: previous
              ? current.grants.map((item) => (item.id === grant.id ? grant : item))
              : [...current.grants, grant],
          },
          result: structuredClone(grant),
        }
      }),
    /** Local cancellation removes delegation and revokes all member-key grants atomically. */
    clearAccountTrust: () =>
      mutate((current) => {
        if (!current.accountTrust) return { next: current, result: [] as Grant[] }
        const keys = new Set(current.accountTrust.devices.map((device) => device.publicKey))
        const revoked: Grant[] = []
        const grants = current.grants.map((grant) => {
          if (grant.revokedAt !== null || !keys.has(grant.publicKey)) return grant
          const updated = { ...grant, version: grant.version + 1, revokedAt: Date.now() }
          revoked.push(updated)
          return updated
        })
        const { accountTrust: _, ...rest } = current
        return { next: { ...rest, grants }, result: structuredClone(revoked) }
      }),
    /** Advancing authority and revoking removed keys share one durable atomic write. */
    acceptRoster: (hubURL: string, input: unknown) =>
      mutate(async (current) => {
        const trust = current.accountTrust
        if (!trust || new URL(hubURL).origin !== trust.hubURL)
          throw new Error("Account is not locally bound to this Hub")
        const accepted = await DeviceRoster.accept(input, {
          accountID: trust.accountID,
          acceptedSequence: trust.acceptedSequence,
          signerKeys: trust.devices.filter((device) => device.signer).map((device) => device.publicKey),
        })
        const keys = new Set(accepted.roster.devices.map((device) => device.publicKey))
        const removed = new Set(
          trust.devices.filter((device) => !keys.has(device.publicKey)).map((device) => device.publicKey),
        )
        const updated: AccountTrust = {
          ...trust,
          devices: accepted.roster.devices,
          acceptedSequence: accepted.roster.sequence,
          acceptedDigest: accepted.digest,
        }
        return {
          next: {
            ...current,
            accountTrust: updated,
            grants: current.grants.map((grant) =>
              grant.revokedAt === null && removed.has(grant.publicKey)
                ? { ...grant, version: grant.version + 1, revokedAt: Date.now() }
                : grant,
            ),
          },
          result: structuredClone(updated),
        }
      }),
    approve: async (input: {
      publicKey: string
      label: string
      permissions: ReadonlyArray<Permission>
      projectIDs: ReadonlyArray<string>
      sessionIDs: ReadonlyArray<string>
      expiresAt: number
    }) => {
      const grant = Schema.decodeUnknownOption(Grant)({
        ...input,
        id: crypto.randomUUID(),
        version: 1,
        createdAt: Date.now(),
        revokedAt: null,
      })
      if (
        Option.isNone(grant) ||
        input.expiresAt <= Date.now() ||
        (!input.projectIDs.length && !input.sessionIDs.length)
      )
        throw new Error("Invalid device grant")
      await crypto.subtle.importKey("raw", binary(input.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ])
      return mutate((current) => {
        if (current.grants.length >= 1024) throw new Error("Device grant limit reached")
        return { next: { ...current, grants: [...current.grants, grant.value] }, result: structuredClone(grant.value) }
      })
    },
    revoke: (id: string, expectedVersion: number) =>
      mutate((current) => {
        const found = current.grants.find((grant) => grant.id === id)
        if (!found || found.version !== expectedVersion) throw new Error("Device grant version conflict")
        if (found.revokedAt !== null) return { next: current, result: structuredClone(found) }
        const revoked = { ...found, version: found.version + 1, revokedAt: Date.now() }
        return {
          next: { ...current, grants: current.grants.map((grant) => (grant.id === id ? revoked : grant)) },
          result: structuredClone(revoked),
        }
      }),
  }
}
export type Store = Awaited<ReturnType<typeof load>>

async function importIdentity(jwk: State["privateKey"]): Promise<SecureChannel.Identity> {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  )
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge)
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)))
    throw new Error("Invalid host identity")
  return {
    keys: { privateKey, publicKey },
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url"),
  }
}

function binary(value: string) {
  const bytes = Buffer.from(value, "base64url")
  if (bytes.length !== 65 || bytes.toString("base64url") !== value) throw new Error("Invalid device public key")
  return bytes
}

async function read(filename: string): Promise<State | undefined> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (!handle) return
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Unsafe device grant storage")
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > 1024 * 1024) throw new Error("Device grant storage exceeds limit")
    const decoded = decode(bytes.subarray(0, result.bytesRead).toString("utf8"))
    if (
      Option.isNone(decoded) ||
      new Set(decoded.value.grants.map((grant) => grant.id)).size !== decoded.value.grants.length
    )
      throw new Error("Invalid device grant storage")
    return decoded.value
  } finally {
    await handle.close()
  }
}

async function persist(filename: string, state: State) {
  const directory = path.dirname(filename)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe device grant directory")
  const bytes = JSON.stringify(state)
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("Device grant storage exceeds limit")
  const temporary = path.join(directory, `.grants-${crypto.randomUUID()}`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    await rename(temporary, filename)
    if (process.platform !== "win32") {
      const parent = await open(directory, constants.O_RDONLY)
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

/** Never replace the sidecar: SQLite holds its lock in the kernel, including after SIGSTOP. */
async function locked<A>(filename: string, use: () => Promise<A>): Promise<A> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const handle = await open(
    filename + ".lock",
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Unsafe device grant lock")
  } finally {
    await handle.close()
  }
  const native = openGrantLock(filename + ".lock")
  native.exec("PRAGMA busy_timeout = 0")
  try {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        native.exec("BEGIN EXCLUSIVE")
        break
      } catch (error) {
        const busy =
          typeof error === "object" &&
          error !== null &&
          (("code" in error && error.code === "SQLITE_BUSY") || ("errcode" in error && error.errcode === 5))
        if (!busy || Date.now() >= deadline) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
    return await use()
  } finally {
    native.close()
  }
}

/** Fresh atomic-file reads make grants and revocations visible in every window. */
function readSync(filename: string): State {
  const handle = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(handle)
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Unsafe device grant storage")
    const decoded = decode(readFileSync(handle, "utf8"))
    if (Option.isNone(decoded)) throw new Error("Invalid device grant storage")
    return decoded.value
  } finally {
    closeSync(handle)
  }
}
