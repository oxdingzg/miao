import { chmod, mkdir, rename } from "node:fs/promises"
import path from "node:path"

/** Reads a JSON file, or returns undefined when it is missing or unreadable. */
export async function readJson(file: string): Promise<unknown> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return undefined
  return handle.json().catch(() => undefined)
}

/**
 * Writes owner-only (0600) JSON atomically: a crash mid-write leaves the previous
 * file intact instead of a truncated one.
 */
export async function writePrivate(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(value, null, 2))
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

/** Serializes writes of one file so the newest value always lands last. */
export function writer(file: string, onError: (error: unknown) => void) {
  let chain = Promise.resolve()
  return (value: () => unknown) => {
    chain = chain.then(() => writePrivate(file, value())).catch(onError)
    return chain
  }
}
