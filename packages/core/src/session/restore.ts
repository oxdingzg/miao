export * as SessionRestore from "./restore"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

type Client = Database.Interface["db"]

/**
 * Tables merged parent-first so a child never references a row that was not
 * inserted yet when foreign keys are enforced. `message` / `part` are
 * deliberately absent: a compacted source has already dropped them.
 */
const MERGE_ORDER = [
  "project",
  "project_directory",
  "session",
  "session_message",
  "session_input",
  "session_context_epoch",
  // Usage and dispatch rows hang off `session` and were the reason a restored
  // backup reported no cost: the transcript came back, the accounting did not.
  "session_turn_usage",
  "session_tool_usage",
  "session_tool_dispatch",
  // Permission state and notifications are Session-scoped the same way; without
  // them a restored Session re-asks for approvals it had already settled.
  "permission_legacy",
  "permission_native_cursor",
  "permission_handoff",
  "session_notification",
  "session_delegation",
  "todo",
  "session_share",
  "event",
] as const

export interface TableResult {
  readonly table: string
  readonly rows: number
}

/** A table the source had rows in but the target ended up with fewer of. */
export interface Shortfall {
  readonly table: string
  readonly source: number
  readonly target: number
}

export interface Result {
  readonly tables: ReadonlyArray<TableResult>
  readonly sequences: number
  /**
   * Tables where the merge did not land everything the source held. Empty is
   * the only success: `INSERT OR IGNORE` skips a row whose primary key already
   * exists in the target, which is correct for a union but hides a real loss
   * when the target row is a different record.
   */
  readonly shortfalls: ReadonlyArray<Shortfall>
  readonly dryRun: boolean
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

const tableNames = (db: Client, schema: string) =>
  db.all<{ name: string }>(sql.raw(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`)).pipe(
    Effect.orDie,
    Effect.map((rows) => new Set(rows.map((row) => row.name))),
  )

const columnNames = (db: Client, schema: string, table: string) =>
  db.all<{ name: string }>(sql.raw(`PRAGMA ${schema}.table_info(${quote(table)})`)).pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map((row) => row.name)),
  )

/**
 * Compare source and target row counts per table.
 *
 * `INSERT OR IGNORE` unions by primary key, so a row the target already holds
 * is skipped — expected when the target is a superset, a loss when the two
 * records differ. Counting both sides is the only check that distinguishes
 * them without reading every column, and it is what makes "the restore
 * completed" a claim the operator can trust.
 */
const verify = (db: Client, tables: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const shortfalls: Array<Shortfall> = []
    for (const table of tables) {
      const source = yield* db
        .get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM merge.${quote(table)}`))
        .pipe(Effect.orDie)
      const target = yield* db
        .get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM main.${quote(table)}`))
        .pipe(Effect.orDie)
      const from = Number(source?.n ?? 0)
      const to = Number(target?.n ?? 0)
      // The target may legitimately hold more (it is a union), never fewer.
      if (to < from) shortfalls.push({ table, source: from, target: to })
    }
    return shortfalls
  })

const changedRows = (db: Client) =>
  db.get<{ n: number }>(sql.raw("SELECT changes() AS n")).pipe(
    Effect.orDie,
    Effect.map((row) => Number(row?.n ?? 0)),
  )

/**
 * Merges a second miao database into `db` without overwriting anything already
 * present. Rows are unioned by primary key (`INSERT OR IGNORE`); each
 * aggregate's event sequence advances to the larger of the two. Used to bring
 * sessions created after a compaction back into the pre-compaction backup that
 * `miao db restore` runs against.
 */
export const merge = (db: Client, source: string, options?: { dryRun?: boolean }) =>
  Effect.gen(function* () {
    yield* db.run(sql.raw(`ATTACH DATABASE ${literal(source)} AS merge`)).pipe(Effect.orDie)

    const run = Effect.gen(function* () {
      const sourceTables = yield* tableNames(db, "merge")
      if (!sourceTables.has("session")) {
        return yield* Effect.die(new Error(`${source} has no session table; is it a miao database?`))
      }
      const targetTables = yield* tableNames(db, "main")

      // Foreign keys point `event.aggregate_id` at `event_sequence`, so advance
      // the sequences before copying events.
      let sequences = 0
      if (sourceTables.has("event_sequence") && targetTables.has("event_sequence")) {
        if (options?.dryRun) {
          const row = yield* db
            .get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM merge.event_sequence`))
            .pipe(Effect.orDie)
          sequences = Number(row?.n ?? 0)
        } else {
          yield* db
            .run(
              sql.raw(
                `INSERT INTO main.event_sequence (aggregate_id, seq, owner_id)` +
                  ` SELECT aggregate_id, seq, owner_id FROM merge.event_sequence WHERE true` +
                  ` ON CONFLICT(aggregate_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
              ),
            )
            .pipe(Effect.orDie)
          sequences = yield* changedRows(db)
        }
      }

      const results: Array<TableResult> = []
      for (const table of MERGE_ORDER) {
        if (!sourceTables.has(table) || !targetTables.has(table)) continue
        const sourceColumns = new Set(yield* columnNames(db, "merge", table))
        const shared = (yield* columnNames(db, "main", table)).filter((column) => sourceColumns.has(column))
        if (shared.length === 0) continue
        const list = shared.map(quote).join(", ")
        if (options?.dryRun) {
          const row = yield* db
            .get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM merge.${quote(table)}`))
            .pipe(Effect.orDie)
          results.push({ table, rows: Number(row?.n ?? 0) })
          continue
        }
        yield* db
          .run(
            sql.raw(`INSERT OR IGNORE INTO main.${quote(table)} (${list}) SELECT ${list} FROM merge.${quote(table)}`),
          )
          .pipe(Effect.orDie)
        results.push({ table, rows: yield* changedRows(db) })
      }
      // A merge that reports rows but leaves the target short is worse than a
      // failed one: the operator believes the backup is whole. Count both sides
      // per table and surface every shortfall.
      const shortfalls = options?.dryRun ? [] : yield* verify(db, MERGE_ORDER)
      return { tables: results, sequences, shortfalls, dryRun: options?.dryRun === true }
    })

    return yield* run.pipe(Effect.ensuring(db.run(sql.raw("DETACH DATABASE merge")).pipe(Effect.ignore)))
  })
