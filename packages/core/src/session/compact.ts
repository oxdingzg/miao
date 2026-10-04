export * as SessionCompact from "./compact"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionV1 } from "../v1/session"
import { SessionBackfill } from "./backfill"
import { SessionLegacyTables } from "./legacy-tables"

type Client = Database.Interface["db"]

/**
 * Legacy events whose rows the projector materialized into `message` / `part`.
 * Derived from the definitions rather than spelled out, so a version bump
 * cannot silently leave rows behind.
 */
const legacyEvents = [
  SessionV1.Event.MessageUpdated,
  SessionV1.Event.MessageRemoved,
  SessionV1.Event.PartUpdated,
  SessionV1.Event.PartRemoved,
].map((definition) => EventV2.versionedType(definition.type, definition.durable?.version ?? 1))

const legacyTypes = sql.join(
  legacyEvents.map((type) => sql`${type}`),
  sql`, `,
)

/** Rows per delete: deleting all of it at once would grow the WAL to the size of all of it. */
const BATCH = 1_000

/** Tables the legacy events were projected into, child first. */
const legacyTables = ["part", "message"]

export interface Size {
  readonly rows: number
  readonly bytes: number
}

export interface Plan {
  readonly fileBytes: number
  readonly events: ReadonlyArray<{ readonly type: string } & Size>
  readonly eventBytes: number
  readonly tables: ReadonlyArray<{ readonly name: string } & Size>
  /** Aggregates left with no events at all, whose sequence restarts. */
  readonly sequences: number
}

export interface Result extends Plan {
  readonly deleted: number
  readonly dropped: number
  readonly reset: number
}

export interface Options {
  readonly dryRun?: boolean
  readonly onProgress?: (progress: { readonly type: string; readonly remaining: number }) => void
}

export class ProjectionIncompleteError extends Error {
  constructor(readonly report: { readonly sessions: number; readonly failures: number }) {
    super(
      `refusing to drop legacy storage: ${report.sessions} session(s) hold messages without a projection and` +
        ` ${report.failures} row(s) do not survive a projection round trip — run \`miao db backfill\` first`,
    )
  }
}

/**
 * Retires the legacy V1 storage once its history lives in the V2 projection:
 * deletes the `message.*` events, drops `message` / `part`, restarts the
 * sequence of any aggregate those events were the last of, and vacuums so the
 * file shrinks. Measured on this repository's own databases, `event` held 1.6 GB
 * of legacy full-snapshot rows against 19 MB of the delta events that replaced
 * them, and `message` / `part` another 384 MB.
 */
export const compact = (db: Client, options: Options = {}) =>
  Effect.gen(function* () {
    const before = yield* inspect(db)
    if (options.dryRun) return { ...before, deleted: 0, dropped: 0, reset: 0 } satisfies Result

    // Deletes and drops commit before VACUUM, so a structurally broken database
    // would be half-retired before the failure surfaces. Check first and stop
    // with the actual corruption instead.
    const integrity = yield* db.get<{ quick_check: string }>(sql.raw("PRAGMA quick_check")).pipe(Effect.orDie)
    if (integrity?.quick_check !== "ok")
      return yield* Effect.die(
        new Error(
          `refusing to compact: PRAGMA quick_check reported ${integrity?.quick_check ?? "no result"}` +
            " — restore the database from a consistent backup before retrying",
        ),
      )

    const report = yield* SessionBackfill.verify(db)
    if (report.failures.length > 0 || report.sessions > 0)
      return yield* Effect.die(
        new ProjectionIncompleteError({ sessions: report.sessions, failures: report.failures.length }),
      )

    // Which aggregates the deletes can empty, resolved while their events are
    // still there to be counted.
    const affected = yield* db
      .all<{ aggregate_id: string }>(sql`SELECT DISTINCT aggregate_id FROM event WHERE type IN (${legacyTypes})`)
      .pipe(Effect.orDie)

    let deleted = 0
    for (const type of legacyEvents) deleted += yield* deleteType(db, type, options)
    const dropped = yield* dropTables(db)
    const reset = yield* resetSequences(
      db,
      affected.map((row) => row.aggregate_id),
    )

    // Delete frees pages but never shrinks the file; only VACUUM rewrites it.
    yield* db.run(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)")).pipe(Effect.orDie)
    yield* db.run(sql.raw("VACUUM")).pipe(Effect.orDie)

    return { ...(yield* inspect(db)), deleted, dropped, reset } satisfies Result
  })

const inspect = (db: Client) =>
  Effect.gen(function* () {
    const pragma = (name: string) => db.get<Record<string, unknown>>(sql.raw(`PRAGMA ${name}`)).pipe(Effect.orDie)
    const pageSize = Number((yield* pragma("page_size"))?.["page_size"] ?? 0)
    const pageCount = Number((yield* pragma("page_count"))?.["page_count"] ?? 0)

    // `LENGTH(data)` is the JSON text itself, so these sizes exclude indexes.
    // The file size above is what the operation actually reclaims.
    const events = yield* db
      .all<{ type: string; rows: number; bytes: number }>(
        sql`SELECT type, COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes
            FROM event WHERE type IN (${legacyTypes}) GROUP BY type ORDER BY bytes DESC`,
      )
      .pipe(Effect.orDie)

    const tables: { name: string; rows: number; bytes: number }[] = []
    if (yield* SessionLegacyTables.present(db))
      for (const name of legacyTables)
        tables.push({
          name,
          ...(yield* db
            .get<{
              rows: number
              bytes: number
            }>(sql`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM ${sql.identifier(name)}`)
            .pipe(Effect.orDie))!,
        })

    // Aggregates whose events are all legacy are the ones the deletes will
    // leave empty, so their sequence restarts. Deleting the sequence of an
    // aggregate that still has events would cascade those events away with it.
    const sequences = yield* db
      .get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM event_sequence s
            WHERE EXISTS (SELECT 1 FROM event e WHERE e.aggregate_id = s.aggregate_id AND e.type IN (${legacyTypes}))
              AND NOT EXISTS (SELECT 1 FROM event e WHERE e.aggregate_id = s.aggregate_id AND e.type NOT IN (${legacyTypes}))`,
      )
      .pipe(Effect.orDie)

    return {
      fileBytes: pageSize * pageCount,
      events,
      eventBytes: events.reduce((total, event) => total + Number(event.bytes), 0),
      tables,
      sequences: Number(sequences?.n ?? 0),
    } satisfies Plan
  })

const deleteType = (db: Client, type: string, options: Options) =>
  Effect.gen(function* () {
    // Collect the ids once. Deleting `WHERE type = ?` in a loop re-scans the
    // whole `event` table for every batch (there is no type-leading index), so
    // it is O(rows^2 / BATCH) on a multi-gigabyte table. The id list is bounded
    // by one legacy type, and the deletes then use the primary key.
    const ids = yield* db.all<{ id: string }>(sql`SELECT id FROM event WHERE type = ${type}`).pipe(Effect.orDie)
    let deleted = 0
    for (let index = 0; index < ids.length; index += BATCH) {
      const list = sql.join(
        ids.slice(index, index + BATCH).map((row) => sql`${row.id}`),
        sql`, `,
      )
      const written = yield* db.all(sql`DELETE FROM event WHERE id IN (${list}) RETURNING id`).pipe(Effect.orDie)
      deleted += written.length
      options.onProgress?.({ type, remaining: ids.length - deleted })
      // Move each batch out of the WAL as it goes: a passive checkpoint cannot
      // truncate while this connection reads, but it keeps reusing the same
      // frames instead of letting the WAL grow to the size of the whole delete.
      yield* db.run(sql.raw("PRAGMA wal_checkpoint(PASSIVE)")).pipe(Effect.orDie)
    }
    return deleted
  })

const dropTables = (db: Client) =>
  Effect.gen(function* () {
    if (!(yield* SessionLegacyTables.present(db))) return 0
    for (const name of legacyTables) yield* db.run(sql.raw(`DROP TABLE ${name}`)).pipe(Effect.orDie)
    return legacyTables.length
  })

/**
 * An aggregate whose events are all gone restarts at sequence 0, matching the
 * negative sequences the backfill gave its projected messages. `commitDurableEvent`
 * reads the next sequence from this table, so leaving a stale high-water mark
 * would only produce gaps.
 */
const resetSequences = (db: Client, aggregates: ReadonlyArray<string>) => {
  if (aggregates.length === 0) return Effect.succeed(0)
  const ids = sql.join(
    aggregates.map((id) => sql`${id}`),
    sql`, `,
  )
  return db
    .all(
      sql`DELETE FROM event_sequence
          WHERE aggregate_id IN (${ids})
            AND NOT EXISTS (SELECT 1 FROM event e WHERE e.aggregate_id = event_sequence.aggregate_id)
          RETURNING aggregate_id`,
    )
    .pipe(
      Effect.map((reset) => reset.length),
      Effect.orDie,
    )
}
