export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Schedule, Semaphore } from "effect"
import { Flock } from "../util/flock"
import { RuntimeOwnership } from "../runtime/ownership"
import type { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)
const initialization = Semaphore.makeUnsafe(1)

/** Never change schema while another window holds a storage-use lock. */
export function initialize(db: Database, usage: { exclusive: () => void; share: () => void }) {
  return initialization.withPermit(
    Effect.gen(function* () {
      const table = yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"migration"}`)
      const completed = table
        ? new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)).map((row) => row.id))
        : new Set<string>()
      if (!table || migrations.some((migration) => !completed.has(migration.id))) {
        yield* upgradeExclusive(usage)
        yield* apply(db)
      }
      yield* Effect.sync(usage.share)
      yield* verify(db)
    }),
  )
}

// A schema upgrade demands exclusive storage usage. When another miao window is
// still open it holds shared usage, and failing immediately reads as "a new
// miao cannot be opened while one is running". Wait for the other window to
// quit instead — the runtime lock is held only by live connections, so the
// wait ends on its own; Ctrl+C cancels it.
function upgradeExclusive(usage: { exclusive: () => void }) {
  let noticed = false
  return Effect.try({
    try: () => usage.exclusive(),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => (error instanceof RuntimeOwnership.BusyError ? Effect.fail(error) : Effect.die(error))),
    Effect.tapError((error) => {
      if (!(error instanceof RuntimeOwnership.BusyError)) return Effect.void
      return Effect.sync(() => {
        if (noticed) return
        noticed = true
        process.stderr.write(
          "miao: this database needs a schema upgrade; waiting for other running miao windows to quit (Ctrl+C to cancel)...\n",
        )
      })
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis") }),
  )
}

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
    }),
  )
}

/** Verify the required schema while retaining shared storage usage. */
export function verify(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const table = yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"migration"}`)
      if (!table) return yield* Effect.die("Database has no migration journal; exclusive migration is required")
      const completed = new Set(
        (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
      )
      const missing = migrations.find((migration) => !completed.has(migration.id))
      if (missing) return yield* Effect.die(`Database schema is older than this build; missing migration ${missing.id}`)
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  // Hold a cross-process file lock so two processes sharing one database file
  // cannot apply the same migration concurrently.
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect("database-migration")
      yield* db.run(
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
      )
      let completed = new Set(
        (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
      )
      if (completed.size === 0) {
        // Existing installs used Drizzle's migration journal. Seed the new
        // journal once so TypeScript migrations don't replay old SQL.
        if (
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
        ) {
          const named = (yield* db.all<{ name: string }>(
            sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
          )).some((column) => column.name === "name")

          if (named) {
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              SELECT name, ${Date.now()}
              FROM ${sql.identifier("__drizzle_migrations")}
              WHERE name IS NOT NULL
            `)
          }

          if (!named) {
            const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
              SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
              FROM ${sql.identifier("__drizzle_migrations")}
              WHERE created_at IS NOT NULL
            `)

            for (const entry of entries) {
              const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
              if (!migration) {
                return yield* Effect.die(
                  new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
                )
              }
              yield* db.run(sql`
                INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
                VALUES (${migration.id}, ${Date.now()})
              `)
            }
          }
          completed = new Set(
            (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
          )
        }
      }

      for (const migration of input) {
        if (completed.has(migration.id)) continue
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* migration.up(tx)
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            )
          }),
        )
      }
    }),
  )
}
