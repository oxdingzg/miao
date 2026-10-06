export * as Maintenance from "./maintenance"

import { Database as NativeDatabase } from "bun:sqlite"
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "path"
import { Blob } from "@miao/core/blob"
import { DatabaseFile } from "@miao/core/database/file"
import { Effect } from "effect"
import { SessionBlobGc } from "@miao/core/session/blob-gc"
import { BlobSiblings } from "./blob-siblings"

// One maintenance pass per data directory per day, no matter how many miao
// processes start: the marker's mtime gates the pass. Two processes starting
// at the same moment can still both run; every step is safe to repeat.
const EVERY_MS = 24 * 60 * 60 * 1000
const FIRST_DELAY_MS = 5 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
// Automatic sweeps stay more conservative than `db gc-blobs`: an orphan must
// be a week old before it is collectable without a human asking for it.
const GRACE_MS = 7 * EVERY_MS

let timer: Timer | undefined

/** Detached like the monitor sampler: never keeps a short CLI invocation alive. */
export function start() {
  if (timer) return
  if (process.env.MIAO_MAINTENANCE === "0") return
  if (DatabaseFile.path() === ":memory:") return
  const first = setTimeout(() => void tick(), FIRST_DELAY_MS)
  first.unref?.()
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
  timer.unref?.()
}

async function tick() {
  const marker = join(dirname(DatabaseFile.path()), "maintenance.last")
  const state = await stat(marker).catch(() => undefined)
  if (state !== undefined && Date.now() - state.mtimeMs < EVERY_MS) return
  const summary = await runOnce().catch((error) => {
    console.error("miao maintenance failed:", error instanceof Error ? error.message : error)
    return undefined
  })
  if (summary === undefined) return
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, new Date().toISOString()).catch(() => {})
}

export type Summary = {
  readonly databases: number
  readonly referenced: number
  readonly orphans: number
  readonly deleted: number
  readonly checkpointed: boolean
}

/**
 * One pass: union every channel database's blob references, sweep the blobs no
 * database references, then truncate each write-ahead log so space from
 * earlier deletions returns to the filesystem. Errors on one database skip
 * only that database; a sweep that cannot read every sibling never deletes.
 */
export const runOnce = async (root: string = dirname(DatabaseFile.path())): Promise<Summary> => {
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => /^miao.*\.db$/.test(name))
  const referenced = new Set<string>()
  let databases = 0
  for (const name of names) {
    const references = await Effect.runPromise(BlobSiblings.collectReferences(join(root, name))).catch(
      () => undefined,
    )
    if (references === undefined) continue
    databases += 1
    for (const hash of references) referenced.add(hash)
  }
  if (databases < names.length) {
    return { databases, referenced: referenced.size, orphans: 0, deleted: 0, checkpointed: false }
  }
  const blobDirectory = join(root, Blob.DIRECTORY)
  const result = await Effect.runPromise(
    SessionBlobGc.sweep({
      blob: {
        remove: (hash) =>
          Effect.tryPromise(async () => {
            await unlink(join(blobDirectory, hash))
            return true
          }),
      },
      directory: blobDirectory,
      referenced,
      graceMs: GRACE_MS,
    }),
  )
  let checkpointed = false
  for (const name of names) checkpointed = checkpoint(join(root, name)) || checkpointed
  return {
    databases,
    referenced: result.referenced,
    orphans: result.orphans,
    deleted: result.deleted,
    checkpointed,
  }
}

function checkpoint(file: string) {
  try {
    const native = new NativeDatabase(file)
    try {
      native.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } finally {
      native.close()
    }
    return true
  } catch {
    return false
  }
}
