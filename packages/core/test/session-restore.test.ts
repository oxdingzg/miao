import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database as SQLite } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { EventSequenceTable, EventTable } from "@miao/core/event/sql"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionRestore } from "@miao/core/session/restore"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionTable } from "@miao/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

const count = (db: Database.Interface["db"], query: ReturnType<typeof sql>) =>
  db.get<{ n: number }>(query).pipe(
    Effect.map((row) => Number(row?.n ?? 0)),
    Effect.orDie,
  )

const seed = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make("ses_a"),
        project_id: Project.ID.global,
        slug: "a",
        directory: "/project",
        title: "A",
        version: "1",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db.insert(EventSequenceTable).values({ aggregate_id: "ses_a", seq: 1 }).run().pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({
        id: EventV2.ID.make("evt_a_1"),
        aggregate_id: "ses_a",
        seq: 1,
        type: "session.next.prompted.1",
        data: { sessionID: "ses_a" },
      })
      .run()
      .pipe(Effect.orDie)
  })

/** Snapshots the target, then adds rows the target never saw to the copy. */
const withSource = <A, E, R>(
  db: Database.Interface["db"],
  add: (source: string) => void,
  use: (source: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "miao-restore-"))
    const source = join(dir, "source.db")
    try {
      yield* db.run(sql.raw(`VACUUM INTO '${source}'`)).pipe(Effect.orDie)
      add(source)
      return yield* use(source)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

describe("SessionRestore", () => {
  it.effect("merges sessions and events the target is missing", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)

      const result = yield* withSource(
        db,
        (source) => {
          const sqlite = new SQLite(source)
          sqlite.run(
            `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_b', '${Project.ID.global}', 'b', '/project', 'B', '1', 1, 1)`,
          )
          sqlite.run(`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_b', 1)`)
          sqlite.run(
            `INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_b_1', 'ses_b', 1, 'session.next.prompted.1', '{"sessionID":"ses_b"}')`,
          )
          sqlite.close()
        },
        (source) => SessionRestore.merge(db, source),
      )

      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM session`)).toBe(2)
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event`)).toBe(2)
      expect(result.tables.find((table) => table.table === "session")?.rows).toBe(1)
      expect(result.tables.find((table) => table.table === "event")?.rows).toBe(1)
    }),
  )

  it.effect("advances an existing aggregate sequence to the larger value", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)

      const result = yield* withSource(
        db,
        (source) => {
          const sqlite = new SQLite(source)
          sqlite.run(`UPDATE event_sequence SET seq = 5 WHERE aggregate_id = 'ses_a'`)
          sqlite.close()
        },
        (source) => SessionRestore.merge(db, source),
      )

      expect(yield* count(db, sql`SELECT seq AS n FROM event_sequence WHERE aggregate_id = 'ses_a'`)).toBe(5)
      expect(result.sequences).toBe(1)
    }),
  )

  it.effect("does not overwrite rows the target already has", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)

      const result = yield* withSource(
        db,
        () => undefined,
        (source) => SessionRestore.merge(db, source),
      )

      expect(result.tables.every((table) => table.rows === 0)).toBe(true)
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM session`)).toBe(1)
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event`)).toBe(1)
    }),
  )
})
