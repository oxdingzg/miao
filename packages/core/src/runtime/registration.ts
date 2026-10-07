export * as RuntimeRegistration from "./registration"

import { RuntimeIdentity } from "./identity"
import { Challenge, Proof } from "@miao/schema/runtime-identity"
import { Schema } from "effect"
import { constants } from "node:fs"
import { open, readdir, rename, unlink } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { randomBytes } from "node:crypto"

const Record = Schema.Struct({
  url: Schema.String,
  runtimeID: Proof.fields.runtimeID,
  version: Schema.String.check(Schema.isMaxLength(128)),
  protocol: Schema.Literal(1),
  storageID: Challenge,
  credential: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
  configurationID: Schema.optional(Challenge),
})
export type Record = typeof Record.Type

export class IdentityError extends Error {
  override readonly name = "RuntimeRegistration.IdentityError"
  constructor() {
    super("Local Runtime identity could not be verified; no authentication was sent")
  }
}

/** Publish only this invocation’s private attachment record after its listener is ready. */
export async function publish(storage: string, record: Record) {
  Schema.decodeUnknownSync(Record)(record)
  requireLocalURL(record.url)
  const filename = recordPath(storage, record.runtimeID)
  const temporary = `${filename}.${randomBytes(16).toString("hex")}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(record))
    await file.sync()
    await file.close()
    await rename(temporary, filename)
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function read(storage: string, runtimeID: string): Promise<Record | undefined> {
  const file = await open(recordPath(storage, runtimeID), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (!file) return undefined
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4096) throw new IdentityError()
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      throw new IdentityError()
    const buffer = Buffer.alloc(4097)
    const result = await file.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > 4096) throw new IdentityError()
    const record = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Record)))(
      buffer.subarray(0, result.bytesRead).toString("utf8"),
    )
    requireLocalURL(record.url)
    return record
  } finally {
    await file.close()
  }
}

/** Every readable record published for this storage; undecodable entries are skipped. */
export async function list(storage: string): Promise<Record[]> {
  const prefix = `${basename(storage)}.runtime-`
  const entries = await readdir(dirname(storage)).catch(() => [])
  const records = await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
      .sort()
      .map((entry) => read(storage, entry.slice(prefix.length, -5)).catch(() => undefined)),
  )
  return records.filter((record): record is Record => record !== undefined)
}

/** This request contains no Basic header or discovery secret, even on failure. */
export async function attest(record: Record, expected: { version: string; storageID: string }) {
  Schema.decodeUnknownSync(Record)(record)
  const url = requireLocalURL(record.url)
  if (record.version !== expected.version || record.storageID !== expected.storageID) throw new IdentityError()
  const challenge = randomBytes(32).toString("hex")
  url.pathname = "/api/runtime/identity"
  url.searchParams.set("challenge", challenge)
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new IdentityError()
  const proof = await readProof(response)
  if (
    proof.runtimeID !== record.runtimeID ||
    proof.version !== record.version ||
    proof.protocol !== record.protocol ||
    proof.storageID !== record.storageID ||
    proof.url !== record.url ||
    !RuntimeIdentity.verify(proof, challenge, record.credential)
  )
    throw new IdentityError()
  return record
}

async function readProof(response: Response) {
  if (!response.body) throw new IdentityError()
  const reader = response.body.getReader()
  const state = { size: 0, text: "" }
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      state.size += chunk.value.byteLength
      if (state.size > 4096) throw new IdentityError()
      state.text += decoder.decode(chunk.value, { stream: true })
    }
    return Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Proof)))(
      state.text + decoder.decode(),
    )
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Remove only this invocation’s record; peers keep their own attachments. */
export async function remove(storage: string, runtimeID: string) {
  const record = await read(storage, runtimeID)
  if (record?.runtimeID === runtimeID) await unlink(recordPath(storage, runtimeID))
}

function requireLocalURL(input: string) {
  const url = new URL(input)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new IdentityError()
  return url
}

function recordPath(storage: string, runtimeID: string) {
  const id = Schema.decodeUnknownSync(Proof.fields.runtimeID)(runtimeID)
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new IdentityError()
  return `${storage}.runtime-${id}.json`
}
