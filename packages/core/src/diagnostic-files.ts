// Diagnostic artifacts are expendable: bounded storage must never fail a turn.
import fs from "node:fs"
import path from "node:path"

export const MiB = 1024 * 1024

export type Budget = {
  match: (name: string) => boolean
  maxBytes: number
  maxFiles: number
}

type Artifact = { file: string; bytes: number; modified: number }

function retention(files: Artifact[], budget: Budget, reserveBytes: number, keep?: string) {
  const adding = keep && !files.some((file) => file.file === keep) ? 1 : 0
  const state = { bytes: files.reduce((sum, file) => sum + file.bytes, 0), files: files.length }
  const remove: string[] = []
  for (const file of files) {
    if (file.file === keep) continue
    if (
      state.bytes + reserveBytes <= budget.maxBytes &&
      state.files + adding <= budget.maxFiles &&
      Date.now() - file.modified < 7 * 24 * 60 * 60 * 1000
    )
      continue
    remove.push(file.file)
    state.bytes -= file.bytes
    state.files -= 1
  }
  return { remove, fits: state.bytes + reserveBytes <= budget.maxBytes }
}

/** Cross-process lease. A crashed writer's lease can be recovered. */
export function lease(directory: string) {
  const lock = path.join(directory, ".diagnostic-write-lock")
  try {
    fs.mkdirSync(directory, { recursive: true })
    try {
      fs.mkdirSync(lock)
    } catch {
      const owner = fs.existsSync(path.join(lock, "pid")) ? Number(fs.readFileSync(path.join(lock, "pid"), "utf8")) : 0
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0)
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return
        }
      } else if (Date.now() - fs.statSync(lock).mtimeMs <= 60_000) return
      fs.rmSync(lock, { recursive: true })
      fs.mkdirSync(lock)
    }
    try {
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid))
    } catch {
      fs.rmSync(lock, { recursive: true, force: true })
      return
    }
    return () => {
      try {
        fs.rmSync(lock, { recursive: true, force: true })
      } catch {}
    }
  } catch {
    return
  }
}

/** Caller holds the lease. Only explicitly managed regular files are removed. */
export function prune(directory: string, budget: Budget, reserveBytes = 0, keep?: string) {
  const files = fs
    .readdirSync(directory)
    .flatMap((name) => {
      if (!budget.match(name)) return []
      const file = path.join(directory, name)
      const stat = fs.lstatSync(file, { throwIfNoEntry: false })
      return stat?.isFile() ? [{ file, bytes: stat.size, modified: stat.mtimeMs }] : []
    })
    .sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file))
  const plan = retention(files, budget, reserveBytes, keep)
  plan.remove.forEach((file) => fs.unlinkSync(file))
  return plan.fits
}

/** Startup cleanup also bounds historical artifacts when recording is disabled. */
export function cleanup(directory: string, budget: Budget) {
  const release = lease(directory)
  if (!release) return
  try {
    prune(directory, budget)
  } catch {
  } finally {
    release()
  }
}

/** Rotation reopens paths on every write, so another process can safely rotate. */
export function append(file: string, text: string, maxFileBytes: number, budget: Budget) {
  if (Buffer.byteLength(text) > maxFileBytes) return false
  const directory = path.dirname(file)
  const release = lease(directory)
  if (!release) return false
  try {
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (size + Buffer.byteLength(text) > maxFileBytes) {
      const backup = `${file}.previous`
      fs.rmSync(backup, { force: true })
      fs.renameSync(file, backup)
    }
    if (!prune(directory, budget, Buffer.byteLength(text), file)) return false
    fs.appendFileSync(file, text)
    return true
  } catch {
    return false
  } finally {
    release()
  }
}

/** Same cross-process lease and retention policy without blocking an isolate. */
async function leaseAsync(directory: string) {
  const lock = path.join(directory, ".diagnostic-write-lock")
  await fs.promises.mkdir(directory, { recursive: true })
  const acquired = await fs.promises.mkdir(lock).then(
    () => true,
    () => false,
  )
  if (!acquired) {
    const owner = Number(await fs.promises.readFile(path.join(lock, "pid"), "utf8").catch(() => "0"))
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return
      }
    } else if (Date.now() - (await fs.promises.stat(lock)).mtimeMs <= 60_000) return
    await fs.promises.rm(lock, { recursive: true })
    await fs.promises.mkdir(lock)
  }
  const written = await fs.promises.writeFile(path.join(lock, "pid"), String(process.pid)).then(
    () => true,
    () => false,
  )
  if (!written) {
    await fs.promises.rm(lock, { recursive: true, force: true })
    return
  }
  return () => fs.promises.rm(lock, { recursive: true, force: true }).catch(() => {})
}

async function pruneAsync(directory: string, budget: Budget, reserveBytes = 0, keep?: string) {
  const files = (
    await Promise.all(
      (await fs.promises.readdir(directory)).filter(budget.match).map(async (name) => {
        const file = path.join(directory, name)
        const stat = await fs.promises.lstat(file).catch(() => undefined)
        return stat?.isFile() ? { file, bytes: stat.size, modified: stat.mtimeMs } : undefined
      }),
    )
  )
    .filter((file): file is Artifact => file !== undefined)
    .sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file))
  const plan = retention(files, budget, reserveBytes, keep)
  await Promise.all(plan.remove.map((file) => fs.promises.unlink(file)))
  return plan.fits
}

export async function cleanupAsync(directory: string, budget: Budget) {
  const release = await leaseAsync(directory).catch(() => undefined)
  if (!release) return
  try {
    await pruneAsync(directory, budget)
  } catch {
  } finally {
    await release()
  }
}

export async function appendAsync(file: string, text: string, maxFileBytes: number, budget: Budget) {
  const bytes = Buffer.byteLength(text)
  if (bytes > maxFileBytes) return false
  const directory = path.dirname(file)
  const release = await leaseAsync(directory).catch(() => undefined)
  if (!release) return false
  try {
    const size = await fs.promises.stat(file).then(
      (stat) => stat.size,
      () => 0,
    )
    if (size + bytes > maxFileBytes) {
      await fs.promises.rm(`${file}.previous`, { force: true })
      await fs.promises.rename(file, `${file}.previous`)
    }
    if (!(await pruneAsync(directory, budget, bytes, file))) return false
    await fs.promises.appendFile(file, text)
    return true
  } catch {
    return false
  } finally {
    await release()
  }
}

export * as DiagnosticFiles from "./diagnostic-files"
