import path from "path"
import { appendFile, mkdir, rename, rm } from "fs/promises"

export function readText(filePath: string) {
  return Bun.file(filePath).text()
}

export function readJson<T>(filePath: string) {
  return Bun.file(filePath).json() as Promise<T>
}

export async function writeText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, content)
}

export async function appendText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, content)
}

/**
 * Best-effort durable JSON write: atomic on success, never rejects.
 *
 * On Windows the destination can be held open momentarily by antivirus or the
 * search indexer, failing the rename with EPERM/EACCES/EBUSY, and a rejected
 * fire-and-forget save used to take the whole TUI down with an unhandled
 * rejection. Retry briefly, then fall back to an in-place overwrite, and
 * swallow whatever still fails: these files are preference caches, and losing
 * a save is always cheaper than crashing.
 */
export async function writeJsonAtomic(filePath: string, value: unknown) {
  const content = JSON.stringify(value)
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await Bun.write(temporary, content)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(temporary, filePath)
        return
      } catch {
        await Bun.sleep(100 * (attempt + 1))
      }
    }
    await rm(temporary, { force: true }).catch(() => undefined)
    await Bun.write(filePath, content)
  } catch {
    // Persistence failures are logged nowhere and remembered by no one; the
    // next save overwrites anyway.
  }
}
