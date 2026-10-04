export * as DeviceGrants from "./grants"

import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { Option, Schema } from "effect"
import { SecureChannel } from "./secure-channel"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
const PublicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/))
export const Permission = Schema.Literals([
  "read",
  "prompt",
  "permission.reply",
  "question.reply",
  "interrupt",
  "session.create",
  "session.rename",
])
export const Grant = Schema.Struct({
  id: ID,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  publicKey: PublicKey,
  label: Schema.String.check(Schema.isLengthBetween(1, 128)),
  permissions: Schema.Array(Permission).check(Schema.isLengthBetween(1, 16)),
  projectIDs: Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 128))).check(Schema.isMaxLength(128)),
  sessionIDs: Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 128))).check(Schema.isMaxLength(256)),
  createdAt: Schema.Int,
  expiresAt: Schema.Int,
  revokedAt: Schema.NullOr(Schema.Int),
})
export type Grant = typeof Grant.Type
export type Permission = typeof Permission.Type

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
})
type State = typeof State.Type
const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(State)))

/** Open only under the Runtime's exclusive storage ownership, once per host.
 * Owner-only administration is deliberately not part of the remote data plane.
 */
export async function load(filename: string) {
  const saved = await read(filename)
  const generated = saved ? undefined : await SecureChannel.createIdentity()
  const exported = generated ? await crypto.subtle.exportKey("jwk", generated.keys.privateKey) : undefined
  const initial: State = saved ?? {
    version: 1,
    hostID: crypto.randomUUID(),
    privateKey: { kty: "EC", crv: "P-256", x: exported!.x!, y: exported!.y!, d: exported!.d! },
    grants: [],
  }
  const identity = generated ?? (await importIdentity(initial.privateKey))
  const state = { value: initial, tail: Promise.resolve(), available: true }
  if (!saved) await persist(filename, initial)
  function mutate<T>(update: (current: State) => { next: State; result: T }) {
    const pending = state.tail.then(async () => {
      if (!state.available) throw new Error("Device grant storage unavailable")
      const updated = update(state.value)
      await persist(filename, updated.next).catch((error: unknown) => {
        state.available = false
        throw error
      })
      state.value = updated.next
      return updated.result
    })
    state.tail = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
  function active(publicKey: string, now = Date.now()) {
    if (!state.available) return []
    return state.value.grants.filter(
      (grant) => grant.publicKey === publicKey && grant.revokedAt === null && grant.expiresAt > now,
    )
  }
  return {
    hostID: initial.hostID,
    identity,
    list: () => structuredClone(state.value.grants),
    active: (publicKey: string) => structuredClone(active(publicKey)),
    get: (id: string, publicKey: string) => structuredClone(active(publicKey).find((grant) => grant.id === id)),
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
