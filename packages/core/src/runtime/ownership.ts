export * as RuntimeOwnership from "./ownership"

import { openRuntimeLock } from "#sqlite"
import { chmod, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

export class BusyError extends Error {
  override readonly name = "RuntimeOwnership.BusyError"
  constructor() {
    super("This storage already has a running Runtime; attach to that Runtime instead")
  }
}

export type Owner = {
  readonly storage: string
  readonly release: () => void
}

/** Holds a kernel-backed SQLite exclusive lock until release or process death.
 * The sidecar is never deleted: replacing it would allow two independent locks.
 */
export async function acquire(filename: string): Promise<Owner> {
  if (filename === ":memory:") throw new Error("Runtime ownership requires persistent storage")
  const resolved = path.resolve(filename)
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const storage = await realpath(resolved).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return realpath(path.dirname(resolved)).then((parent) => path.join(parent, path.basename(resolved)))
    throw error
  })
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
