export * as SessionAutoBackfill from "./auto-backfill"

import fs from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionBackfill } from "./backfill"

export type Result =
  | { readonly status: "current" }
  | { readonly status: "no-space"; readonly sessions: number; readonly needed: number; readonly available: number }
  | {
      readonly status: "migrated"
      readonly backup: string
      readonly migrated: number
      readonly repaired: number
    }

export interface Options {
  /** The database file `db` is open on. */
  readonly file: string
  /** Free bytes on the volume holding `directory`; injectable for tests. */
  readonly available?: (directory: string) => number
  readonly now?: Date
}

/**
 * One-time startup migration of legacy V1 sessions into the V2 projection. A
 * database with nothing to migrate costs one probe. Otherwise the file is copied
 * to `<file>.bak-YYYYMMDD-HHMMSS` first — the same `.bak-<date>` snapshot the
 * manual procedure takes with `sqlite3 .backup` — and only then backfilled. When
 * the volume cannot hold that copy the migration is skipped, not forced: the
 * legacy fallback keeps serving those sessions and the next start tries again.
 * `miao db compact` stays manual; this never drops legacy data.
 */
export const run = (db: Database.Interface["db"], options: Options) =>
  Effect.gen(function* () {
    const pending = yield* SessionBackfill.backfill(db, { dryRun: true })
    const sessions = pending.migrated + pending.repaired
    if (sessions === 0) return { status: "current" } satisfies Result

    // The copy needs room for the main file plus whatever the WAL still holds.
    const size = [options.file, `${options.file}-wal`].reduce(
      (total, file) => total + (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0),
      0,
    )
    const needed = Math.ceil(size * 1.1) + 64 * 1024 * 1024
    const available = (options.available ?? freeBytes)(path.dirname(options.file))
    if (available < needed) return { status: "no-space", sessions, needed, available } satisfies Result

    const backup = `${options.file}.bak-${stamp(options.now ?? new Date())}`
    // VACUUM INTO writes a consistent snapshot from a live connection, like `.backup`.
    yield* db.run(sql`VACUUM INTO ${backup}`).pipe(Effect.orDie)
    const result = yield* SessionBackfill.backfill(db)
    return { status: "migrated", backup, ...result } satisfies Result
  })

function freeBytes(directory: string) {
  const stats = fs.statfsSync(directory)
  return stats.bavail * stats.bsize
}

function stamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}
