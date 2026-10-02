import { mkdir, open, readFile, unlink } from "node:fs/promises"
import path from "node:path"

export type Lock = { readonly release: () => Promise<void> }

/**
 * Takes an exclusive pid lock file. A lock left by a process that no longer
 * exists is taken over; a live holder makes this fail with its pid.
 */
export async function acquireLock(file: string, retried = false): Promise<Lock | { readonly holder: number }> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const created = await open(file, "wx", 0o600).then(
    (handle) => handle,
    () => undefined,
  )
  if (created) {
    await created.writeFile(String(process.pid))
    await created.close()
    return { release: () => release(file) }
  }
  const holder = await lockHolder(file)
  if (holder !== undefined) return { holder }
  // Lost a race with another starter that took over the same stale lock.
  if (retried) return { holder: 0 }
  // Stale: the holder exited without cleaning up. Remove it and try exactly once more.
  await unlink(file).catch(() => undefined)
  return acquireLock(file, true)
}

/** The pid holding the lock, if that process is still alive. */
export async function lockHolder(file: string) {
  const pid = Number((await readFile(file, "utf8").catch(() => "")).trim())
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return alive(pid) ? pid : undefined
}

async function release(file: string) {
  const pid = Number((await readFile(file, "utf8").catch(() => "")).trim())
  if (pid === process.pid) await unlink(file).catch(() => undefined)
}

function alive(pid: number) {
  // Signal 0 checks for existence without delivering anything; EPERM still means it exists.
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
