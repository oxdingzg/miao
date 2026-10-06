export * as RuntimeOwnership from "./ownership"

import { openRuntimeLock } from "#sqlite"
import { chmod, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

export class BusyError extends Error {
  override readonly name = "RuntimeOwnership.BusyError"
  constructor(message = "This storage already has a running Runtime; close its windows before exclusive maintenance") {
    super(message)
  }
}

export type Owner = {
  readonly storage: string
  readonly release: () => void
}

const shared = new Map<string, { owner: Promise<Owner>; users: number }>()

export type Usage = Owner & {
  readonly exclusive: () => void
  readonly share: () => void
}

/** Each database scope retains its own reader, including during a peer's failed upgrade. */
export async function use(filename: string): Promise<Usage> {
  return usage(await canonicalStorage(filename))
}

async function usage(storage: string): Promise<Usage> {
  const filename = `${storage}.runtime-lock`
  const native = openRuntimeLock(filename)
  const state = { exclusive: false, released: false }
  const share = () => {
    if (state.exclusive) native.exec("ROLLBACK")
    // Acquisition retries belong to the caller; native waits multiply that
    // budget and block the event loop while another process owns this store.
    native.exec("BEGIN; SELECT name FROM sqlite_master LIMIT 1")
    state.exclusive = false
  }
  try {
    await chmod(filename, 0o600)
    native.exec("PRAGMA busy_timeout = 0")
    // Prefer exclusive initialization so simultaneous first openers cannot both
    // hold read locks on an empty database and prevent its initial migration.
    try {
      native.exec("BEGIN EXCLUSIVE")
      state.exclusive = true
    } catch (error) {
      if (!busy(error)) throw error
      share()
    }
  } catch (error) {
    native.close()
    if (busy(error)) throw new BusyError()
    throw error
  }
  return {
    storage,
    share: () => {
      if (!state.exclusive) return
      share()
    },
    exclusive: () => {
      if (state.exclusive) return
      native.exec("ROLLBACK")
      try {
        native.exec("BEGIN EXCLUSIVE")
        state.exclusive = true
      } catch (error) {
        if (busy(error)) throw new BusyError("Close other miao windows before migrating or maintaining this database")
        throw error
      }
    },
    release: () => {
      if (state.released) return
      state.released = true
      native.close()
    },
  }
}

function busy(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === "SQLITE_BUSY") || ("errcode" in error && error.errcode === 5))
  )
}

/** Independent service scopes in one process share its single OS ownership lease. */
export async function acquireShared(filename: string): Promise<Owner> {
  const storage = await canonicalStorage(filename)
  const existing = shared.get(storage)
  const entry = existing ?? { owner: acquire(storage), users: 0 }
  if (!existing) shared.set(storage, entry)
  entry.users++
  const owner = await entry.owner.catch((error: unknown) => {
    if (shared.get(storage) === entry) shared.delete(storage)
    throw error
  })
  const state = { released: false }
  return {
    storage,
    release: () => {
      if (state.released) return
      state.released = true
      entry.users--
      if (entry.users > 0) return
      shared.delete(storage)
      owner.release()
    },
  }
}

/** Holds a kernel-backed SQLite exclusive lock until release or process death.
 * The sidecar is never deleted: replacing it would allow two independent locks.
 */
export async function acquire(filename: string): Promise<Owner> {
  const storage = await canonicalStorage(filename)
  const lockfile = `${storage}.runtime-lock`
  const native = openRuntimeLock(lockfile)
  const state = { released: false }
  try {
    await chmod(lockfile, 0o600)
    native.exec("PRAGMA busy_timeout = 0")
    native.exec("PRAGMA journal_mode = DELETE")
    native.exec("PRAGMA locking_mode = EXCLUSIVE")
    native.exec("BEGIN EXCLUSIVE")
  } catch (error) {
    native.close()
    if (typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY")
      throw new BusyError()
    // node:sqlite exposes SQLite result codes separately from its Node error code.
    if (typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5) throw new BusyError()
    throw error
  }
  return {
    storage,
    release: () => {
      if (state.released) return
      state.released = true
      try {
        native.exec("ROLLBACK")
      } finally {
        native.close()
      }
    },
  }
}

export async function canonicalStorage(filename: string): Promise<string> {
  if (filename === ":memory:") throw new Error("Runtime ownership requires persistent storage")
  const resolved = path.resolve(filename)
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
  return realpath(resolved).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return realpath(path.dirname(resolved)).then((parent) => path.join(parent, path.basename(resolved)))
    throw error
  })
}
