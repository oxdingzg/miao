export * as SessionMigrationReverse from "./migration-reverse"

import { eq } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { Database } from "../database/database"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionEnginePlacementTable } from "./engine-placement.sql"
import { EventV2 } from "../event"
import { ProjectTable, ProjectDirectoryTable } from "../project/sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { ProjectSchema } from "../project/schema"
import { WorkspaceV2 } from "../workspace"
import { SessionMigration } from "./migration"
import { SessionStore } from "./store"
import { SessionMigrationTable } from "./migration.sql"

type Db = Database.Interface["db"]
type Native = Extract<SessionEnginePlacement.Placement, { engine: "rust" }>

export type Input = {
  id: string
  sessionID: SessionID
  native: Native
  bundleSHA256: string
}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionMigrationReverse.Conflict", {
  sessionID: SessionID,
}) {}

const requiresNative = Effect.fnUntraced(function* (db: Db, input: Input) {
  const placement = yield* SessionEnginePlacement.find(db, input.sessionID)
  if (
    placement?.engine !== "rust" ||
    placement.storage !== input.native.storage ||
    placement.location.directory !== input.native.location.directory ||
    placement.location.workspaceID !== input.native.location.workspaceID
  )
    return yield* new Conflict({ sessionID: input.sessionID })
  return placement
})

const requiresTypeScript = Effect.fnUntraced(function* (db: Db, sessionID: SessionID) {
  const placement = yield* SessionEnginePlacement.find(db, sessionID)
  if (placement?.engine !== "ts") return yield* new Conflict({ sessionID })
  return placement
})

/** Record the durable reverse intent from the exact payload the native host
 * exported. The TypeScript import is staged before the authority flips. */
export const prepare = Effect.fn("SessionMigrationReverse.prepare")(function* (
  db: Db,
  input: Input & { bundle: string; sourceSeq: number },
) {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        yield* requiresNative(db, input)
        const existing = yield* SessionMigration.find(db, input.id)
        if (existing) {
          if (
            existing.direction !== "rust_to_ts" ||
            existing.session_id !== input.sessionID ||
            existing.bundle_sha256 !== input.bundleSHA256 ||
            existing.bundle !== input.bundle
          )
            return yield* new Conflict({ sessionID: input.sessionID })
          return existing
        }
        if (yield* SessionMigration.active(db, input.sessionID))
          return yield* new Conflict({ sessionID: input.sessionID })
        yield* db
          .insert(SessionMigrationTable)
          .values({
            id: input.id,
            session_id: input.sessionID,
            state: "prepared",
            direction: "rust_to_ts",
            native_storage: input.native.storage,
            location: input.native.location,
            bundle_sha256: input.bundleSHA256,
            bundle: input.bundle,
            source_seq: input.sourceSeq,
            created_at: now,
            updated_at: now,
          })
          .run()
          .pipe(Effect.orDie)
        return (yield* SessionMigration.find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Flip authority back to the TypeScript engine in one transaction. After this
 * commit the native source is no longer authoritative, so recovery must finish
 * the staged TypeScript import rather than start a new transfer. */
export const switchToTypeScript = Effect.fn("SessionMigrationReverse.switchToTypeScript")(function* (
  db: Db,
  input: Input,
) {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const current = yield* SessionMigration.find(db, input.id)
        if (
          !current ||
          current.direction !== "rust_to_ts" ||
          current.session_id !== input.sessionID ||
          current.bundle_sha256 !== input.bundleSHA256 ||
          current.native_storage !== input.native.storage ||
          current.location.directory !== input.native.location.directory ||
          current.location.workspaceID !== input.native.location.workspaceID
        )
          return yield* new Conflict({ sessionID: input.sessionID })
        if (current.state === "switched" || current.state === "completed") {
          yield* requiresTypeScript(db, input.sessionID)
          return current
        }
        if (current.state !== "prepared") return yield* new Conflict({ sessionID: input.sessionID })
        yield* requiresNative(db, input)
        yield* db
          .update(SessionEnginePlacementTable)
          .set({ engine: "ts", native_storage: null, location: null })
          .where(eq(SessionEnginePlacementTable.session_id, input.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* requiresTypeScript(db, input.sessionID)
        yield* db
          .update(SessionMigrationTable)
          .set({ state: "switched", updated_at: now })
          .where(eq(SessionMigrationTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return (yield* SessionMigration.find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Completion requires the TypeScript catalog import to be durable; the caller
 * only sets this after that import committed. */
export const complete = Effect.fn("SessionMigrationReverse.complete")(function* (db: Db, input: Input) {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const current = yield* SessionMigration.find(db, input.id)
        if (
          !current ||
          current.direction !== "rust_to_ts" ||
          current.session_id !== input.sessionID ||
          current.bundle_sha256 !== input.bundleSHA256
        )
          return yield* new Conflict({ sessionID: input.sessionID })
        if (current.state === "completed") return current
        if (current.state !== "switched") return yield* new Conflict({ sessionID: input.sessionID })
        yield* requiresTypeScript(db, input.sessionID)
        yield* db
          .update(SessionMigrationTable)
          .set({ state: "completed", updated_at: now })
          .where(eq(SessionMigrationTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return (yield* SessionMigration.find(db, input.id))!
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Restore the exported durable events into an empty TypeScript aggregate.
 * Replay is the only writer: it re-commits each event with its original id and
 * sequence through the normal projectors, so the restored catalog is built by
 * the same code that originally produced it. */
export const importHistory = Effect.fn("SessionMigrationReverse.importHistory")(function* (
  db: Db,
  input: {
    sessionID: SessionID
    catalog: { projectID: string; workspaceID: string; directory: string }
    events: readonly EventV2.SerializedEvent[]
  },
) {
  if (input.events.length === 0 || input.events.some((event) => event.aggregateID !== input.sessionID))
    return yield* new Conflict({ sessionID: input.sessionID })
  // The session projector owns the session/message rows, but a catalog row is
  // not part of the Session aggregate, so it is rebuilt from the exported
  // placement facts before replay.
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectSchema.ID.make(input.catalog.projectID),
      worktree: input.catalog.directory as never,
      sandboxes: [] as never,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectDirectoryTable)
    .values({
      project_id: ProjectSchema.ID.make(input.catalog.projectID),
      directory: input.catalog.directory as never,
      type: "main",
      time_created: 0,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  if (input.catalog.workspaceID.startsWith("wrk"))
    yield* db
      .insert(WorkspaceTable)
      .values({
        id: WorkspaceV2.ID.make(input.catalog.workspaceID),
        type: "local",
        name: "",
        project_id: ProjectSchema.ID.make(input.catalog.projectID),
        time_used: 0,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  const events = yield* EventV2.Service
  const store = yield* SessionStore.Service
  const source = yield* events.replayAll([...input.events], { publish: true })
  if (source !== input.sessionID) return yield* new Conflict({ sessionID: input.sessionID })
  const session = yield* store.get(input.sessionID)
  if (!session) return yield* new Conflict({ sessionID: input.sessionID })
  const expected = Math.max(...input.events.map((event) => event.seq))
  if ((yield* EventV2.latestSequence(db, input.sessionID)) !== expected)
    return yield* new Conflict({ sessionID: input.sessionID })
  return session
})
