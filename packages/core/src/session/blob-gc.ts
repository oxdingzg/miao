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
const collect = (into: Set<string>, value: unknown) => {
  if (typeof value === "string") {
    for (const match of value.matchAll(REF)) into.add(match[1]!)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(into, item)
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collect(into, item)
  }
}

/**
 * Mark-and-sweep for the content-addressed blob store. Marks every `blob://`
 * hash referenced by `session_message`, `event`, and `session_input` rows, then
 * deletes blob files that nothing references and that are older than the grace
 * window (so a blob written for an in-flight write is not collected). Pass
 * `dryRun` to report without deleting. See `specs/storage/session-storage-hardening.md`.
 */
export const sweep = (input: {
  readonly blob: Blob.Interface
  readonly db: DatabaseService
  readonly directory: string
  readonly dryRun?: boolean
  readonly graceMs?: number
  readonly now?: number
}) =>
  Effect.gen(function* () {
    const referenced = new Set<string>()

    const sessions = yield* input.db
      .selectDistinct({ id: SessionMessageTable.session_id })
      .from(SessionMessageTable)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of sessions) {
      const rows = yield* input.db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, id))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) collect(referenced, row.data)
    }

    const aggregates = yield* input.db
      .selectDistinct({ id: EventTable.aggregate_id })
      .from(EventTable)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of aggregates) {
      const rows = yield* input.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, id))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) collect(referenced, row.data)
    }

    const inputs = yield* input.db.select({ prompt: SessionInputTable.prompt }).from(SessionInputTable).all().pipe(
      Effect.orDie,
    )
    for (const row of inputs) collect(referenced, row.prompt)

    const now = input.now ?? Date.now()
    const grace = input.graceMs ?? 24 * 60 * 60 * 1000
    const files = yield* Effect.promise(() => readdir(input.directory).catch(() => [] as string[]))
    let orphans = 0
    let bytes = 0
    let deleted = 0
    for (const hash of files) {
      if (referenced.has(hash)) continue
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
    return { referenced: referenced.size, orphans, bytes, deleted } satisfies Report
  })
