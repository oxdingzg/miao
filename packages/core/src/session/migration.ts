export * as SessionMigration from "./migration"

import { and, eq, notInArray, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionMigrationTable } from "./migration.sql"
import { SessionTable } from "./sql"

type Db = Database.Interface["db"]
type Native = Extract<SessionEnginePlacement.Placement, { engine: "rust" }>

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionMigration.Conflict", {
  sessionID: SessionID,
}) {}

export const find = Effect.fn("SessionMigration.find")(function* (db: Db, id: string) {
  return yield* db.select().from(SessionMigrationTable).where(eq(SessionMigrationTable.id, id)).get().pipe(Effect.orDie)
})

export const active = Effect.fn("SessionMigration.active")(function* (db: Db, sessionID: SessionID) {
  return yield* db
    .select()
    .from(SessionMigrationTable)
    .where(
      and(
        eq(SessionMigrationTable.session_id, sessionID),
        notInArray(SessionMigrationTable.state, ["completed", "aborted"]),
      ),
    )
    .get()
    .pipe(Effect.orDie)
})

/** Offline operator orchestration must hold the source Session ownership lease
 * before freezing. This transaction then fences later admission after crashes.
 * It does not transfer placement or start target execution. */
export const freeze = Effect.fn("SessionMigration.freeze")(function* (
  db: Db,
  input: { id: string; sessionID: SessionID; target: Native; bundleSHA256: string; sourceSeq: number },
) {
  if (
    !input.id ||
    input.id.length > 128 ||
    !/^[a-f0-9]{64}$/.test(input.bundleSHA256) ||
    !Number.isSafeInteger(input.sourceSeq) ||
    input.sourceSeq < -1
  )
    return yield* new Conflict({ sessionID: input.sessionID })
  const target = Schema.decodeUnknownSync(SessionEnginePlacement.Placement)(input.target)
  if (target.engine !== "rust") return yield* new Conflict({ sessionID: input.sessionID })
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        // Keep the fence in SQLite as well: a source process using an older
        // build may not know this table, but its durable writes must fail too.
        // Completed native transfers allow accepted catalog metadata mirrors;
        // they still forbid old TS transcript/execution writes.
        yield* db
          .run(
            sql`
          CREATE TRIGGER IF NOT EXISTS session_migration_event_fence
          BEFORE INSERT ON event
          WHEN EXISTS (
            SELECT 1 FROM session_migration AS migration
            WHERE migration.session_id = NEW.aggregate_id
              AND (
                migration.state IN ('frozen', 'prepared', 'switched')
                OR (
                  migration.state = 'completed'
                  AND NEW.type != 'session.next.info.updated.1'
                  AND EXISTS (
                    SELECT 1 FROM session_engine_placement AS placement
                    WHERE placement.session_id = NEW.aggregate_id AND placement.engine = 'rust'
                  )
                )
              )
          )
          BEGIN
            SELECT RAISE(ABORT, 'Session is frozen for engine migration');
          END
        `,
          )
          .pipe(Effect.orDie)
        const existing = yield* find(db, input.id)
        if (existing) {
          if (
            existing.session_id !== input.sessionID ||
            existing.state === "aborted" ||
            existing.native_storage !== target.storage ||
            existing.location.directory !== target.location.directory ||
            existing.location.workspaceID !== target.location.workspaceID ||
            existing.bundle_sha256 !== input.bundleSHA256 ||
            existing.source_seq !== input.sourceSeq
          )
            return yield* new Conflict({ sessionID: input.sessionID })
          return existing
        }
        const session = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        const placement = yield* SessionEnginePlacement.find(db, input.sessionID)
        if (
          !session ||
          placement?.engine === "rust" ||
          (yield* active(db, input.sessionID)) ||
          (yield* EventV2.latestSequence(db, input.sessionID)) !== input.sourceSeq
        )
          return yield* new Conflict({ sessionID: input.sessionID })
        yield* db
          .insert(SessionMigrationTable)
          .values({
            id: input.id,
            session_id: input.sessionID,
            state: "frozen",
            native_storage: target.storage,
            location: target.location,
            bundle_sha256: input.bundleSHA256,
            source_seq: input.sourceSeq,
            created_at: now,
            updated_at: now,
          })
          .run()
          .pipe(Effect.orDie)
        return (yield* find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Abort releases a pre-cutover source freeze. Once switched, only the reverse
 * transfer may return authority; abort must never revive the old writer. */
export const abort = Effect.fn("SessionMigration.abort")(function* (
  db: Db,
  input: { id: string; sessionID: SessionID },
) {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const existing = yield* find(db, input.id)
        if (
          !existing ||
          existing.session_id !== input.sessionID ||
          !["frozen", "prepared", "aborted"].includes(existing.state)
        )
          return yield* new Conflict({ sessionID: input.sessionID })
        if (existing.state === "aborted") return existing
        const placement = yield* SessionEnginePlacement.find(db, input.sessionID)
        if (placement?.engine === "rust") return yield* new Conflict({ sessionID: input.sessionID })
        yield* db
          .update(SessionMigrationTable)
          .set({ state: "aborted", updated_at: now })
          .where(eq(SessionMigrationTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return (yield* find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})
