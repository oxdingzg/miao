import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { AbsolutePath } from "../schema"
import type { SessionID } from "@miao/schema/session-id"
import { Database } from "../database/database"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionEnginePlacementTable } from "./engine-placement.sql"
import { SessionMigration } from "./migration"
import { SessionMigrationTable } from "./migration.sql"

type Db = Database.Interface["db"]

type Native = Extract<SessionEnginePlacement.Placement, { engine: "rust" }>

/** The engine control-channel operations a rust→rust move needs. The product
 * tool bridge host implements this on top of the same Requester the
 * migration coordinator uses. */
export interface MoveEngine {
  exportMove(input: {
    sessionID: string
    productDatabase: AbsolutePath
    targetDirectory: string
    bundleFile: AbsolutePath
  }): Effect.Effect<MoveReceipt, Error>
  stageNative(input: {
    importID: string
    path: AbsolutePath
    bundleSHA256: string
    identity: { protocol: string; model: string }
    routeID?: string
    agent?: Record<string, unknown>
  }): Effect.Effect<MoveReceipt, Error>
  activate(input: {
    importID: string
    bundleSHA256: string
    productDatabase: AbsolutePath
  }): Effect.Effect<MoveReceipt, Error>
}

const Receipt = Schema.Struct({
  session_id: Schema.optional(Schema.String),
  bundle_sha256: Schema.String,
  state: Schema.optional(Schema.String),
  binding: Schema.optional(
    Schema.Struct({
      protocol: Schema.String,
      model: Schema.String,
      route_id: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  route_id: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.Unknown),
})
export type MoveReceipt = typeof Receipt.Type
export const decodeMoveReceipt = Schema.decodeUnknownSync(Receipt)

/** Move an engine-owned Session to a new Location inside the same engine
 * fleet (the worktree bridge). Sequential with a single durable fence: the
 * placement rewrite names the destination, after which re-running the move
 * completes it (stage and activate are exact-retry/idempotent); before the
 * fence a failure leaves the source untouched and the call simply failed. */
export const moveRust = Effect.fn("SessionMoveCoordinator.moveRust")(function* (input: {
  database: Db
  id: string
  sessionID: SessionID
  source: Native
  target: Native
  bundleFile: AbsolutePath
  productDatabase: AbsolutePath
  identity: { protocol: string; model: string }
  routeID?: string
  agent?: Record<string, unknown>
  engine: MoveEngine
}) {
  const fail = () => Effect.fail(new SessionMigration.Conflict({ sessionID: input.sessionID }))
  const receipt = yield* input.engine.exportMove({
    sessionID: input.sessionID,
    productDatabase: input.productDatabase,
    targetDirectory: input.target.location.directory,
    bundleFile: input.bundleFile,
  })
  if (receipt.session_id && receipt.session_id !== input.sessionID) return yield* fail()
  const bundleSHA256 = receipt.bundle_sha256

  // The fence: the product authority names the destination from here on.
  // A crash after this transaction is recovered by re-running the same move:
  // the export re-succeeds on the drained source, staging adopts the exact
  // import, and activation completes or acknowledges the active import.
  const fenced = yield* movePlacement(input.database, {
    id: input.id,
    sessionID: input.sessionID,
    source: input.source,
    target: input.target,
    bundleSHA256,
  })
  if (fenced.state === "completed") return yield* fail()

  const binding = receipt.binding
    ? { protocol: receipt.binding.protocol, model: receipt.binding.model }
    : input.identity
  const routeID = receipt.route_id ?? input.routeID
  const staged = yield* input.engine.stageNative({
    importID: input.id,
    path: input.bundleFile,
    bundleSHA256,
    identity: binding,
    routeID: routeID ?? undefined,
    agent: (receipt.agent as Record<string, unknown> | undefined) ?? input.agent,
  })
  if (staged.bundle_sha256 !== bundleSHA256 || staged.session_id !== input.sessionID) return yield* fail()
  const activated = yield* input.engine.activate({
    importID: input.id,
    bundleSHA256,
    productDatabase: input.productDatabase,
  })
  if (activated.state !== "active") return yield* fail()
})

/** The placement fence lives beside the other migration transitions because
 * it writes the same two tables under the same rules. */
const movePlacement = (
  db: Db,
  input: {
    id: string
    sessionID: SessionID
    source: Native
    target: Native
    bundleSHA256: string
  },
) =>
  db.transaction(() =>
    Effect.gen(function* () {
      const observed = yield* SessionMigration.find(db, input.id)
      if (observed && observed.bundle_sha256 === input.bundleSHA256 && observed.state !== "aborted") {
        return observed
      }
      if (observed) return yield* new SessionMigration.Conflict({ sessionID: input.sessionID })
      const placement = yield* SessionEnginePlacement.find(db, input.sessionID)
      if (!placement || placement.engine !== "rust" || placement.storage !== input.source.storage) {
        return yield* new SessionMigration.Conflict({ sessionID: input.sessionID })
      }
      const now = Date.now()
      yield* db
        .insert(SessionMigrationTable)
        .values({
          id: input.id,
          session_id: input.sessionID,
          state: "switched",
          direction: "rust_to_rust",
          native_storage: input.target.storage,
          location: input.target.location,
          bundle_sha256: input.bundleSHA256,
          source_seq: -1,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionEnginePlacementTable)
        .set({ native_storage: input.target.storage, location: input.target.location })
        .where(
          and(
            eq(SessionEnginePlacementTable.session_id, input.sessionID),
            eq(SessionEnginePlacementTable.engine, "rust"),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      return { id: input.id, state: "switched" as const }
    }),
  )

export * as SessionMoveCoordinator from "./move-coordinator"
