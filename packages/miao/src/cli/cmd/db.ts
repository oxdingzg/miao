import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@miao/core/database/database"
import { SessionBackfill } from "@miao/core/session/backfill"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

const StatsCommand = effectCmd({
  command: "stats",
  describe: "report database size and per-table / per-event-type usage",
  instance: false,
  handler: Effect.fn("Cli.db.stats")(function* () {
    const { db } = yield* Database.Service
    const pragma = (name: string) =>
      db.get<Record<string, unknown>>(sql.raw(`PRAGMA ${name}`)).pipe(Effect.orDie)
    const pageSize = Number((yield* pragma("page_size"))?.page_size ?? 0)
    const pageCount = Number((yield* pragma("page_count"))?.page_count ?? 0)
    const freelist = Number((yield* pragma("freelist_count"))?.freelist_count ?? 0)
    const autoVacuum = Number((yield* pragma("auto_vacuum"))?.auto_vacuum ?? 0)
    const journalValue = (yield* pragma("journal_mode"))?.journal_mode
    const journal = typeof journalValue === "string" ? journalValue : ""

    console.log(`path:        ${Database.path()}`)
    console.log(`journal:     ${journal}   auto_vacuum: ${autoVacuum}`)
    console.log(`size:        ${mb(pageSize * pageCount)} MB   free: ${mb(pageSize * freelist)} MB`)

    const tables = yield* db
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .pipe(Effect.orDie)
    console.log("\ntables:")
    for (const table of tables) {
      const row = yield* db
        .get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table.name)}`)
        .pipe(Effect.orDie)
      console.log(`  ${table.name}\t${row?.n ?? 0} rows`)
    }

    const events = yield* db
      .all<{ type: string; n: number; bytes: number }>(
        sql`SELECT type, COUNT(*) AS n, SUM(LENGTH(data)) AS bytes FROM event GROUP BY type ORDER BY bytes DESC`,
      )
      .pipe(Effect.orElseSucceed(() => [] as { type: string; n: number; bytes: number }[]))
    if (events.length > 0) {
      console.log("\nevent types:")
      for (const event of events) console.log(`  ${event.type}\t${event.n}\t${mb(event.bytes ?? 0)} MB`)
    }
  }),
})

const BackfillCommand = effectCmd({
  command: "backfill",
  describe: "convert legacy V1 session messages into the V2 projection (idempotent)",
  instance: false,
  handler: Effect.fn("Cli.db.backfill")(function* () {
    const { db } = yield* Database.Service
    const migrated = yield* SessionBackfill.backfill(db)
    console.log(`backfilled ${migrated} session(s)`)
  }),
})

const VacuumCommand = effectCmd({
  command: "vacuum",
  describe: "checkpoint, enable incremental auto-vacuum, and VACUUM to reclaim free space",
  instance: false,
  handler: Effect.fn("Cli.db.vacuum")(function* () {
    const { db } = yield* Database.Service
    // auto_vacuum is only persisted by VACUUM, and must be requested before it runs.
    yield* db.run(sql.raw("PRAGMA auto_vacuum = INCREMENTAL")).pipe(Effect.orDie)
    yield* db.run(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)")).pipe(Effect.orDie)
    yield* db.run(sql.raw("VACUUM")).pipe(Effect.orDie)
    yield* db.run(sql.raw("PRAGMA incremental_vacuum")).pipe(Effect.orDie)
    console.log("vacuum complete (auto_vacuum=INCREMENTAL)")
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(StatsCommand)
      .command(VacuumCommand)
      .command(BackfillCommand)
      .demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
