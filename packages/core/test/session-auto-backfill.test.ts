import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionAutoBackfill } from "@miao/core/session/auto-backfill"
import { MessageTable, PartTable, SessionTable } from "@miao/core/session/sql"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miao-auto-backfill-"))
  dirs.push(dir)
  return path.join(dir, "miao.db")
}

const withDatabase = <A>(file: string, body: (db: Database.Interface["db"]) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* body(db)
    }).pipe(Effect.provide(Database.layerFromPath(file))),
  )

const seedLegacy = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: "ses_auto_legacy" as never,
        project_id: Project.ID.global,
        slug: "legacy",
        directory: "/project",
        title: "legacy",
        version: "0.0.1",
      })
      .run()
    yield* db
      .insert(MessageTable)
      .values({
        id: "msg_auto_user" as never,
        session_id: "ses_auto_legacy" as never,
        time_created: 1,
        data: { role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } } as never,
      })
      .run()
    yield* db
      .insert(PartTable)
      .values({
        id: "prt_auto_text" as never,
        message_id: "msg_auto_user" as never,
        session_id: "ses_auto_legacy" as never,
        data: { type: "text", text: "hello" } as never,
      })
      .run()
  }).pipe(Effect.orDie)

const count = (file: string, table: string) => {
  const sqlite = new Sqlite(file, { readonly: true })
  try {
    return (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    sqlite.close()
  }
}

describe("SessionAutoBackfill", () => {
  test("does nothing when every session is already projected", async () => {
    const file = fixture()
    const result = await withDatabase(file, (db) => SessionAutoBackfill.run(db, { file }))
    expect(result).toEqual({ status: "current" })
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-"))).toEqual([])
  })

  test("backs the database up with a timestamp before migrating legacy sessions", async () => {
    const file = fixture()
    const result = await withDatabase(file, (db) =>
      Effect.gen(function* () {
        yield* seedLegacy(db)
        return yield* SessionAutoBackfill.run(db, { file, now: new Date(2026, 9, 2, 8, 5, 9) })
      }),
    )
    expect(result).toEqual({
      status: "migrated",
      backup: `${file}.bak-20261002-080509`,
      reused: false,
      migrated: 1,
      repaired: 0,
    })
    // The backup is the pre-migration state; the live file now holds the projection.
    expect(count(`${file}.bak-20261002-080509`, "session_message")).toBe(0)
    expect(count(`${file}.bak-20261002-080509`, "message")).toBe(1)
    expect(count(file, "session_message")).toBe(1)
    // Legacy rows stay until a manual `miao db compact`.
    expect(count(file, "message")).toBe(1)

    const again = await withDatabase(file, (db) => SessionAutoBackfill.run(db, { file }))
    expect(again).toEqual({ status: "current" })

    // A V1 entry point still writing legacy rows must not trigger a fresh copy on every start.
    const later = await withDatabase(file, (db) =>
      Effect.gen(function* () {
        yield* db
          .insert(SessionTable)
          .values({
            id: "ses_auto_later" as never,
            project_id: Project.ID.global,
            slug: "later",
            directory: "/project",
            title: "later",
            version: "0.0.1",
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(MessageTable)
          .values({
            id: "msg_auto_later" as never,
            session_id: "ses_auto_later" as never,
            time_created: 2,
            data: {
              role: "user",
              time: { created: 2 },
              agent: "build",
              model: { providerID: "p", modelID: "m" },
            } as never,
          })
          .run()
          .pipe(Effect.orDie)
        return yield* SessionAutoBackfill.run(db, { file, now: new Date(2026, 9, 3) })
      }),
    )
    expect(later).toEqual({
      status: "migrated",
      backup: `${file}.bak-20261002-080509`,
      reused: true,
      migrated: 1,
      repaired: 0,
    })
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-"))).toEqual([
      "miao.db.bak-20261002-080509",
    ])
    expect(count(file, "session_message")).toBe(2)
  })

  test("skips the migration without writing when the backup would not fit", async () => {
    const file = fixture()
    const result = await withDatabase(file, (db) =>
      Effect.gen(function* () {
        yield* seedLegacy(db)
        return yield* SessionAutoBackfill.run(db, { file, available: () => 1024 })
      }),
    )
    expect(result).toMatchObject({ status: "no-space", sessions: 1, available: 1024 })
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-"))).toEqual([])
    expect(count(file, "session_message")).toBe(0)
  })
})
