export * as SessionMigration from "./migration"

import { and, eq, notInArray, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionMigrationTable } from "./migration.sql"
import { SessionTable } from "./sql"
import { SessionEnginePlacementTable } from "./engine-placement.sql"
import { Hash } from "../util/hash"

type Db = Database.Interface["db"]
type Native = Extract<SessionEnginePlacement.Placement, { engine: "rust" }>
type TransferIdentity = { id: string; sessionID: SessionID; target: Native; bundleSHA256: string }

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
  input: { id: string; sessionID: SessionID; target: Native; bundleSHA256: string; sourceSeq: number; bundle?: string },
) {
  if (
    !input.id ||
    input.id.length > 128 ||
    !/^[a-f0-9]{64}$/.test(input.bundleSHA256) ||
    !Number.isSafeInteger(input.sourceSeq) ||
    input.sourceSeq < -1
  )
    return yield* new Conflict({ sessionID: input.sessionID })
  if (
    input.bundle !== undefined &&
    (Buffer.byteLength(input.bundle) > 64 * 1024 * 1024 || Hash.sha256(input.bundle) !== input.bundleSHA256)
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
            existing.source_seq !== input.sourceSeq ||
            (input.bundle !== undefined && existing.bundle !== input.bundle)
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
            bundle: input.bundle,
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

/** The trusted native Host's prepared receipt names the exact inactive copy.
 * This is recorded separately from the authority switch so restart recovery
 * never treats target preparation as permission to execute. */
export const prepared = Effect.fn("SessionMigration.prepared")(function* (
  db: Db,
  input: TransferIdentity & { receipt: { id: string; session_id: string; bundle_sha256: string; state: "staged" } },
) {
  if (
    input.receipt.id !== input.id ||
    input.receipt.session_id !== input.sessionID ||
    input.receipt.bundle_sha256 !== input.bundleSHA256 ||
    input.receipt.state !== "staged"
  )
    return yield* new Conflict({ sessionID: input.sessionID })
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const current = yield* requireTransfer(db, input)
        if (["switched", "completed"].includes(current.state)) {
          yield* requireNativePlacement(db, input)
          return current
        }
        if (!["frozen", "prepared"].includes(current.state)) return yield* new Conflict({ sessionID: input.sessionID })
        if ((yield* SessionEnginePlacement.find(db, input.sessionID))?.engine === "rust")
          return yield* new Conflict({ sessionID: input.sessionID })
        if (current.state === "prepared") return current
        yield* db
          .update(SessionMigrationTable)
          .set({ state: "prepared", updated_at: now })
          .where(eq(SessionMigrationTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return (yield* find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Placement and migration state change in one immediate transaction. After
 * this commit, abort cannot revive the old writer; recovery must activate the
 * same prepared native copy rather than choosing a new destination. */
export const switchToNative = Effect.fn("SessionMigration.switchToNative")(function* (db: Db, input: TransferIdentity) {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const current = yield* requireTransfer(db, input)
        if (["switched", "completed"].includes(current.state)) {
          yield* requireNativePlacement(db, input)
          return current
        }
        if (current.state !== "prepared" || (yield* EventV2.latestSequence(db, input.sessionID)) !== current.source_seq)
          return yield* new Conflict({ sessionID: input.sessionID })
        const observed = yield* SessionEnginePlacement.find(db, input.sessionID)
        if (observed?.engine === "rust") return yield* new Conflict({ sessionID: input.sessionID })
        if (observed) {
          yield* db
            .update(SessionEnginePlacementTable)
            .set({ engine: "rust", native_storage: input.target.storage, location: input.target.location })
            .where(
              and(
                eq(SessionEnginePlacementTable.session_id, input.sessionID),
                eq(SessionEnginePlacementTable.engine, "ts"),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }
        if (!observed) {
          yield* db
            .insert(SessionEnginePlacementTable)
            .values({
              session_id: input.sessionID,
              engine: "rust",
              native_storage: input.target.storage,
              location: input.target.location,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
        }
        yield* requireNativePlacement(db, input)
        yield* db
          .update(SessionMigrationTable)
          .set({ state: "switched", updated_at: now })
          .where(eq(SessionMigrationTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return (yield* find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** A switched Session stays frozen until the same native import acknowledges
 * activation. The completed record retains its payload for exact recovery. */
export const complete = Effect.fn("SessionMigration.complete")(function* (
  db: Db,
  input: TransferIdentity & { receipt: { id: string; session_id: string; bundle_sha256: string; state: "active" } },
) {
  if (
    input.receipt.id !== input.id ||
    input.receipt.session_id !== input.sessionID ||
    input.receipt.bundle_sha256 !== input.bundleSHA256 ||
    input.receipt.state !== "active"
  )
    return yield* new Conflict({ sessionID: input.sessionID })
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const current = yield* requireTransfer(db, input)
        if (!["switched", "completed"].includes(current.state))
          return yield* new Conflict({ sessionID: input.sessionID })
        yield* requireNativePlacement(db, input)
        if (current.state === "completed") return current
        yield* db
          .update(SessionMigrationTable)
          .set({ state: "completed", updated_at: now })
          .where(eq(SessionMigrationTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return (yield* find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

function requireTransfer(db: Db, input: TransferIdentity) {
  return Effect.gen(function* () {
    const current = yield* find(db, input.id)
    const session = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (
      !session ||
      !current ||
      !current.bundle ||
      current.session_id !== input.sessionID ||
      current.bundle_sha256 !== input.bundleSHA256 ||
      current.native_storage !== input.target.storage ||
      current.location.directory !== input.target.location.directory ||
      current.location.workspaceID !== input.target.location.workspaceID
    )
      return yield* new Conflict({ sessionID: input.sessionID })
    return current
  })
}

function requireNativePlacement(db: Db, input: TransferIdentity) {
  return Effect.gen(function* () {
    const placement = yield* SessionEnginePlacement.find(db, input.sessionID)
    if (
      placement?.engine !== "rust" ||
      placement.storage !== input.target.storage ||
      placement.location.directory !== input.target.location.directory ||
      placement.location.workspaceID !== input.target.location.workspaceID
    )
      return yield* new Conflict({ sessionID: input.sessionID })
    return placement
  })
}
