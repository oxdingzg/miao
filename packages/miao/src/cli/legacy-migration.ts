import fs from "node:fs"
import { Database as Sqlite } from "bun:sqlite"
import { EOL } from "os"

/**
 * Migrates legacy V1 sessions once, before a command opens them. Runs in the
 * CLI process ahead of any server or TUI worker so nothing reads a half-migrated
 * session, and never fails startup: a migration that cannot run is reported and
 * retried on the next start.
 */
export async function migrateLegacySessions() {
  const { DatabaseFile } = await import("@miao/core/database/file")
  const file = DatabaseFile.path()
  if (file === ":memory:" || !fs.existsSync(file) || !pending(file)) return

  try {
    const { Effect } = await import("effect")
    const { Database } = await import("@miao/core/database/database")
    const { SessionAutoBackfill } = await import("@miao/core/session/auto-backfill")
    process.stderr.write(`miao: migrating legacy sessions to the V2 format (one time)...${EOL}`)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* SessionAutoBackfill.run(db, { file })
      }).pipe(Effect.provide(Database.layerFromPath(file))),
    )
    if (result.status === "migrated")
      process.stderr.write(
        `miao: migrated ${result.migrated + result.repaired} legacy session(s); ` +
          `${result.reused ? "pre-migration backup" : "backup"}: ${result.backup}${EOL}`,
      )
    if (result.status === "no-space")
      process.stderr.write(
        `miao: skipped migrating ${result.sessions} legacy session(s): backing up the database first needs ` +
          `${mb(result.needed)} MB free next to ${file}, ${mb(result.available)} MB available. ` +
          `They stay readable; free some space and miao retries on the next start.${EOL}`,
      )
  } catch (error) {
    process.stderr.write(
      `miao: legacy session migration failed, continuing without it: ${error instanceof Error ? error.message : String(error)}${EOL}`,
    )
  }
}

/**
 * A cheap read-only probe so an already migrated or compacted database costs
 * one query at startup. Anything unexpected defers to the full check.
 */
function pending(file: string) {
  const sqlite = (() => {
    try {
      return new Sqlite(file, { readonly: true })
    } catch {
      return undefined
    }
  })()
  if (!sqlite) return false
  try {
    const legacy = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message'").get()
    if (!legacy) return false
    return (
      sqlite
        .query(
          `SELECT 1 FROM message m
           WHERE NOT EXISTS (SELECT 1 FROM session_message x WHERE x.id = m.id AND x.session_id = m.session_id)
           LIMIT 1`,
        )
        .get() !== null
    )
  } catch {
    return true
  } finally {
    sqlite.close()
  }
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
