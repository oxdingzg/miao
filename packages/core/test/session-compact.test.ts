import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionCompact } from "@miao/core/session/compact"
import { SessionSchema } from "@miao/core/session/schema"
import { EventV2 } from "@miao/core/event"
import { EventSequenceTable, EventTable } from "@miao/core/event/sql"
import { MessageTable, PartTable, SessionTable } from "@miao/core/session/sql"
import { SessionV1 } from "@miao/core/v1/session"
import { testEffect } from "./lib/effect"

// Each test builds its own in-memory database, so every test seeds the state it
// needs and compacting one cannot leak into the next.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

const exists = (db: Database.Interface["db"], name: string) =>
  db
    .get(sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ${name} LIMIT 1`)
    .pipe(Effect.orDie)

const count = (db: Database.Interface["db"], query: ReturnType<typeof sql>) =>
  db.get<{ n: number }>(query).pipe(Effect.map((row) => Number(row?.n ?? 0)), Effect.orDie)

/** One legacy message the projection does not cover, which compact must refuse to lose. */
const keepLegacyMessage = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const sessionID = SessionSchema.ID.make("ses_compact")
    const messageID = SessionV1.MessageID.make("msg_compact")
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        time_created: 1,
        time_updated: 1,
        // `Omit` over the V1 message union collapses to the keys both roles
        // share, so this column's declared type is narrower than the row the
        // writers actually store.
        data: {
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "p", modelID: "m" },
        } as never,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values({
        id: SessionV1.PartID.make("prt_compact"),
        message_id: messageID,
        session_id: sessionID,
        time_created: 1,
        time_updated: 1,
        data: { type: "text", text: "hi" } as never,
      })
      .run()
      .pipe(Effect.orDie)
  })

/**
 * An aggregate whose events are only legacy, next to one that also has the V2
 * deltas that replaced them. Both are real shapes from a database mid-migration.
 */
const insertEvents = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    for (const [aggregate, rows] of [
      ["ses_legacy_only", ["message.updated.1", "message.part.updated.1"]],
      ["ses_mixed", ["message.updated.1", "session.next.prompted.1"]],
    ] as const) {
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: aggregate, seq: rows.length })
        .run()
        .pipe(Effect.orDie)
      for (const [index, type] of rows.entries())
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make(`evt_${aggregate}_${index}`),
            aggregate_id: aggregate,
            seq: index + 1,
            type,
            data: { sessionID: aggregate },
          })
          .run()
          .pipe(Effect.orDie)
    }
  })

/** Copies the legacy message into the projection so the completeness gate passes. */
const projectLegacyMessage = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db
      .run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        SELECT id, session_id, 'user', -1, time_created, time_created, data FROM message
      `)
      .pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM message`).pipe(Effect.orDie)
  })

const seed = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* keepLegacyMessage(db)
    yield* insertEvents(db)
  })

describe("SessionCompact", () => {
  it.effect("refuses to drop storage while a legacy message has no projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)

      const exit = yield* SessionCompact.compact(db).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      // The refusal has to leave everything in place.
      expect(yield* exists(db, "message")).toBeDefined()
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event`)).toBe(4)
    }),
  )

  it.effect("deletes legacy events, drops the tables, and resets only emptied sequences", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)
      yield* projectLegacyMessage(db)

      const result = yield* SessionCompact.compact(db)

      expect(result.deleted).toBe(3)
      expect(result.dropped).toBe(2)
      expect(result.reset).toBe(1)
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event WHERE type LIKE 'message.%'`)).toBe(0)
      // The delta events that replaced the legacy ones are untouched, and their
      // aggregate keeps its sequence: deleting it would cascade those events away.
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event WHERE type = 'session.next.prompted.1'`)).toBe(1)
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event_sequence WHERE aggregate_id = 'ses_mixed'`)).toBe(1)
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event_sequence WHERE aggregate_id = 'ses_legacy_only'`)).toBe(
        0,
      )
      expect(yield* exists(db, "message")).toBeUndefined()
      expect(yield* exists(db, "part")).toBeUndefined()

      // The projected message survives the drop, which is the whole point.
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM session_message WHERE id = 'msg_compact'`)).toBe(1)
    }),
  )

  it.effect("reports nothing left to do on a second run", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)
      yield* projectLegacyMessage(db)
      yield* SessionCompact.compact(db)

      const result = yield* SessionCompact.compact(db)
      expect(result).toMatchObject({ deleted: 0, dropped: 0, reset: 0, eventBytes: 0, tables: [] })
      // The V2 event that shared an aggregate with the legacy ones is still there.
      expect(yield* count(db, sql`SELECT COUNT(*) AS n FROM event WHERE type = 'session.next.prompted.1'`)).toBe(1)
    }),
  )
})
