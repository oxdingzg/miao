export * as SessionBlobGc from "./blob-gc"

import { readdir, stat } from "node:fs/promises"
import { join } from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Blob } from "../blob"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { SessionInputTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export type Report = {
  readonly referenced: number
  readonly orphans: number
  readonly bytes: number
  readonly deleted: number
}

/** Content hash inside a `blob://<sha256>` reference. */
const REF = /blob:\/\/([a-f0-9]{64})/g

/**
 * Collects every `blob://` hash anywhere in a decoded JSON value. Scanning the
 * whole value rather than known fields means a reference this code does not know
 * about still protects its blob (a false positive keeps a blob, never deletes a
 * live one).
 */
export const collectHashes = (into: Set<string>, value: unknown) => {
  if (typeof value === "string") {
    for (const match of value.matchAll(REF)) into.add(match[1]!)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHashes(into, item)
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectHashes(into, item)
  }
}

/**
 * Marks every `blob://` hash one database references from `session_message`,
 * `event`, and `session_input` rows. A blob directory can be shared by several
 * channel databases, so callers must union this across all of them before
 * sweeping.
 */
export const collect = (db: DatabaseService) =>
  Effect.gen(function* () {
    const referenced = new Set<string>()

    const sessions = yield* db
      .selectDistinct({ id: SessionMessageTable.session_id })
      .from(SessionMessageTable)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of sessions) {
      const rows = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, id))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) collectHashes(referenced, row.data)
    }

    const aggregates = yield* db
      .selectDistinct({ id: EventTable.aggregate_id })
      .from(EventTable)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of aggregates) {
      const rows = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, id))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) collectHashes(referenced, row.data)
    }

    const inputs = yield* db.select({ prompt: SessionInputTable.prompt }).from(SessionInputTable).all().pipe(
      Effect.orDie,
    )
    for (const row of inputs) collectHashes(referenced, row.prompt)

    return referenced
  })

/**
 * Deletes blob files that no channel database references and that are older than
 * the grace window (so a blob written for an in-flight write is not collected).
 * Pass `dryRun` to report without deleting. See
 * `specs/storage/session-storage-hardening.md`.
 */
export const sweep = (input: {
  readonly blob: { readonly remove: (hash: string) => Effect.Effect<boolean, unknown> }
  readonly directory: string
  readonly referenced: ReadonlySet<string>
  readonly dryRun?: boolean
  readonly graceMs?: number
  readonly now?: number
}) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const grace = input.graceMs ?? 24 * 60 * 60 * 1000
    const files = yield* Effect.promise(() => readdir(input.directory).catch(() => [] as string[]))
    let orphans = 0
    let bytes = 0
    let deleted = 0
    for (const hash of files) {
      if (input.referenced.has(hash)) continue
      const info = yield* Effect.promise(() => stat(join(input.directory, hash)).catch(() => undefined))
      if (info?.isFile() !== true) continue
      if (now - info.mtimeMs < grace) continue
      orphans += 1
      bytes += info.size
      if (input.dryRun !== true) {
        const removed = yield* input.blob.remove(hash).pipe(Effect.orElseSucceed(() => false))
        if (removed) deleted += 1
      }
    }
    return { referenced: input.referenced.size, orphans, bytes, deleted } satisfies Report
  })
