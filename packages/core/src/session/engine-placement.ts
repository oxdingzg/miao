export * as SessionEnginePlacement from "./engine-placement"

import { and, eq, notInArray } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { Database } from "../database/database"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { SessionTable } from "./sql"
import { SessionEnginePlacementTable } from "./engine-placement.sql"
import { SessionMigrationTable } from "./migration.sql"

export const Placement = Schema.Union([
  Schema.Struct({ engine: Schema.Literal("ts") }),
  Schema.Struct({ engine: Schema.Literal("rust"), storage: AbsolutePath, location: Location.Ref }),
])
export type Placement = typeof Placement.Type

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionEnginePlacement.Conflict", {
  sessionID: SessionID,
}) {}

type Db = Database.Interface["db"]

export const find = Effect.fn("SessionEnginePlacement.find")(function* (db: Db, sessionID: SessionID) {
  const row = yield* db
    .select()
    .from(SessionEnginePlacementTable)
    .where(eq(SessionEnginePlacementTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  return Schema.decodeUnknownSync(Placement)(
    row.engine === "ts" ? { engine: "ts" } : { engine: "rust", storage: row.native_storage, location: row.location },
  )
})

/** Every Session bound to the native engine, with the storage that owns it. */
export const list = Effect.fn("SessionEnginePlacement.list")(function* (db: Db) {
  const rows = yield* db
    .select()
    .from(SessionEnginePlacementTable)
    .where(eq(SessionEnginePlacementTable.engine, "rust"))
    .all()
    .pipe(Effect.orDie)
  return rows.flatMap((row) => {
    const placement = Schema.decodeUnknownOption(Placement)(
      row.engine === "ts" ? { engine: "ts" } : { engine: "rust", storage: row.native_storage, location: row.location },
    )
    if (placement._tag === "None" || placement.value.engine !== "rust") return []
    return [
      {
        sessionID: row.session_id,
        engine: placement.value.engine,
        storage: placement.value.storage,
        location: placement.value.location,
      },
    ]
  })
})

/** Forget a binding. Used when a native Session is removed, so the next create
 * of the same identity is not routed back to a storage that no longer has it. */
export const release = Effect.fn("SessionEnginePlacement.release")(function* (db: Db, sessionID: SessionID) {
  yield* db
    .delete(SessionEnginePlacementTable)
    .where(eq(SessionEnginePlacementTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

/** Exact retries adopt a binding; a different engine, storage, or Location cannot take it over. */
export const claim = Effect.fn("SessionEnginePlacement.claim")(function* (
  db: Db,
  input: { sessionID: SessionID; placement: Placement },
) {
  const placement = Schema.decodeUnknownSync(Placement)(input.placement)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        // Old/imported TS rows remain TS-owned even if their binding has not yet
        // been synthesized. This check and the insert share the write transaction.
        // A row whose binding already exists is a concurrent creator's authority,
        // not a legacy row: re-claiming it with matching facts is idempotent, and
        // only a session without any binding is legacy.
        const legacy = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        const bound = yield* find(db, input.sessionID)
        if (legacy && !bound && placement.engine !== "ts") return yield* new Conflict({ sessionID: input.sessionID })
        yield* db
          .insert(SessionEnginePlacementTable)
          .values({
            session_id: input.sessionID,
            engine: placement.engine,
            native_storage: placement.engine === "rust" ? placement.storage : null,
            location: placement.engine === "rust" ? placement.location : null,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const stored = yield* find(db, input.sessionID)
        if (
          !stored ||
          stored.engine !== placement.engine ||
          (stored.engine === "rust" &&
            placement.engine === "rust" &&
            (stored.storage !== placement.storage ||
              stored.location.directory !== placement.location.directory ||
              stored.location.workspaceID !== placement.location.workspaceID))
        )
          return yield* new Conflict({ sessionID: input.sessionID })
        return stored
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Core callers must respect placement too; HTTP routing is not a write fence. */
export const requireTypeScript = Effect.fn("SessionEnginePlacement.requireTypeScript")(function* (
  db: Db,
  sessionID: SessionID,
) {
  const placement = yield* find(db, sessionID)
  if (placement?.engine === "rust") return yield* Effect.die(new Conflict({ sessionID }))
  const migration = yield* db
    .select({ id: SessionMigrationTable.id })
    .from(SessionMigrationTable)
    .where(
      and(
        eq(SessionMigrationTable.session_id, sessionID),
        notInArray(SessionMigrationTable.state, ["completed", "aborted"]),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (migration) return yield* Effect.die(new Conflict({ sessionID }))
})
