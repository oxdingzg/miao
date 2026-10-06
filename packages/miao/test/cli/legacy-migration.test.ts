import { describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { MessageTable, PartTable, SessionTable } from "@miao/core/session/sql"
import { cliIt } from "../lib/cli-process"

/** A database written by a pre-V2 build: one session that only has V1 rows. */
const seed = (file: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: "ses_startup_legacy" as never,
        project_id: Project.ID.global,
        slug: "legacy",
        directory: path.dirname(file),
        title: "legacy session",
        version: "0.0.1",
      })
      .run()
    yield* db
      .insert(MessageTable)
      .values({
        id: "msg_startup_user" as never,
        session_id: "ses_startup_legacy" as never,
        time_created: 1,
        data: { role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } } as never,
      })
      .run()
    yield* db
      .insert(PartTable)
      .values({
        id: "prt_startup_text" as never,
        message_id: "msg_startup_user" as never,
        session_id: "ses_startup_legacy" as never,
        data: { type: "text", text: "hello" } as never,
      })
      .run()
  }).pipe(Effect.orDie, Effect.provide(Database.layerFromPath(file)))

const projected = (file: string) => {
  const sqlite = new Sqlite(file, { readonly: true })
  try {
    return (sqlite.query("SELECT COUNT(*) AS n FROM session_message").get() as { n: number }).n
  } finally {
    sqlite.close()
  }
}

describe("read-only startup with legacy history", () => {
  cliIt.live(
    "does not backfill or back up history as a startup side effect",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "fixture.db")
        yield* seed(file)

        const first = yield* opencode.spawn(["session", "list", "--format", "json"], { env: { MIAO_DB: file } })
        opencode.expectExit(first, 0, "session list")
        expect(first.stderr).not.toContain("migrated 1 legacy session(s)")
        expect(JSON.parse(first.stdout).map((session: { id: string }) => session.id)).toEqual(["ses_startup_legacy"])
        expect(projected(file)).toBe(0)
        const backups = fs.readdirSync(home).filter((name) => name.startsWith("fixture.db.bak-"))
        expect(backups).toHaveLength(0)

        // Later read-only starts likewise leave history untouched.
        const second = yield* opencode.spawn(["session", "list", "--format", "json"], { env: { MIAO_DB: file } })
        opencode.expectExit(second, 0, "session list")
        expect(second.stderr).not.toContain("legacy session")
        expect(fs.readdirSync(home).filter((name) => name.startsWith("fixture.db.bak-"))).toHaveLength(0)

        // `db` keeps migration explicit.
        const third = yield* opencode.spawn(["db", "path"], { env: { MIAO_DB: file } })
        opencode.expectExit(third, 0, "db path")
      }),
    120_000,
  )
})
