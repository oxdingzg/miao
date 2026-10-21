import { expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { SessionMoveCoordinator } from "../src/session/move-coordinator"
import type { MoveReceipt } from "../src/session/move-coordinator"
import { SessionEnginePlacement } from "../src/session/engine-placement"
import { SessionEnginePlacementTable } from "../src/session/engine-placement.sql"
import { SessionMigration } from "../src/session/migration"
import { SessionMigrationTable } from "../src/session/migration.sql"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  body: Effect.Effect<A, E, Database.Service | SessionV2.Service>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node]), [
          [Database.node, Database.layerFromPath(storage)],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )

const fakeEngine = (sessionID: string, digest = "digest1") => {
  const calls: Array<"stage" | "activate"> = []
  const engine: SessionMoveCoordinator.MoveEngine = {
    exportMove: (input) =>
      Effect.succeed({
        session_id: sessionID,
        bundle_sha256: digest,
        binding: { protocol: "openai-chat", model: "m" },
      } as MoveReceipt),
    stageNative: (input) => {
      calls.push("stage")
      expect(input.bundleSHA256).toBe(digest)
      expect(input.identity).toEqual({ protocol: "openai-chat", model: "m" })
      return Effect.succeed({ session_id: sessionID, bundle_sha256: input.bundleSHA256, state: "staged" })
    },
    activate: (input) => {
      calls.push("activate")
      expect(input.bundleSHA256).toBe(input.bundleSHA256)
      return Effect.succeed({ bundle_sha256: input.bundleSHA256, state: "active" })
    },
  }
  return { calls, engine }
}

test("a rust move fences the placement, then stages and activates at the destination", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  const sourceDir = path.join(tmp.path, "checkout")
  const targetDir = path.join(tmp.path, "worktree")
  const source = {
    engine: "rust" as const,
    storage: AbsolutePath.make(path.join(tmp.path, "source.db")),
    location: { directory: AbsolutePath.make(sourceDir) },
  }
  const target = {
    engine: "rust" as const,
    storage: AbsolutePath.make(path.join(tmp.path, "destination.db")),
    location: { directory: AbsolutePath.make(targetDir) },
  }
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: source.location })
      // Session creation seeds a TS placement row; the move test starts rust.
      yield* database.db
        .update(SessionEnginePlacementTable)
        .set({ engine: "rust", native_storage: source.storage, location: source.location })
        .where(eq(SessionEnginePlacementTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const { calls, engine } = fakeEngine(sessionID)
      yield* SessionMoveCoordinator.moveRust({
        database: database.db,
        id: "move-1",
        sessionID,
        source,
        target,
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        engine,
      })
      expect(calls).toEqual(["stage", "activate"])
      const placement = yield* SessionEnginePlacement.find(database.db, sessionID)
      expect(placement?.engine).toBe("rust")
      if (placement?.engine !== "rust") throw new Error("placement must be rust")
      expect(placement.storage).toBe(target.storage)
      expect(placement.location).toEqual(target.location)
      const migration = yield* SessionMigration.find(database.db, "move-1")
      expect(migration?.state).toBe("switched")
      expect(migration?.direction).toBe("rust_to_rust")
      expect(migration?.bundle_sha256).toBe("digest1")
    }),
  ).catch((error: unknown) => {
    const cause = (error as { cause?: { toString?: () => string } }).cause
    console.log("RUN FAILURE cause:", cause?.toString?.().slice(0, 1200))
    throw error
  })
})

test("a fenced move resumes: the fence adopts the matching record and completes", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  const source = {
    engine: "rust" as const,
    storage: AbsolutePath.make(path.join(tmp.path, "source.db")),
    location: { directory: AbsolutePath.make(path.join(tmp.path, "checkout")) },
  }
  const target = {
    engine: "rust" as const,
    storage: AbsolutePath.make(path.join(tmp.path, "destination.db")),
    location: { directory: AbsolutePath.make(path.join(tmp.path, "worktree")) },
  }
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: source.location })
      // Session creation seeds a TS placement row; the move test starts rust.
      yield* database.db
        .update(SessionEnginePlacementTable)
        .set({ engine: "rust", native_storage: source.storage, location: source.location })
        .where(eq(SessionEnginePlacementTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      // The crash happened after the fence: the single transaction already
      // rewrote the placement, and the matching record makes the fence a
      // no-op while stage and activate complete.
      yield* database.db
        .update(SessionEnginePlacementTable)
        .set({ engine: "rust", native_storage: target.storage, location: target.location })
        .where(eq(SessionEnginePlacementTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionMigrationTable)
        .values({
          id: "move-1",
          session_id: sessionID,
          state: "switched",
          direction: "rust_to_rust",
          native_storage: target.storage,
          location: target.location,
          bundle_sha256: "digest1",
          source_seq: -1,
          created_at: Date.now(),
          updated_at: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      const { calls, engine } = fakeEngine(sessionID)
      yield* SessionMoveCoordinator.moveRust({
        database: database.db,
        id: "move-1",
        sessionID,
        source,
        target,
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        engine,
      })
      expect(calls).toEqual(["stage", "activate"])
      const placement = yield* SessionEnginePlacement.find(database.db, sessionID)
      if (placement?.engine !== "rust") throw new Error("placement must be rust")
      expect(placement.storage).toBe(target.storage)
    }),
  )
})

test("a move whose source placement does not match is refused before the fence", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  const source = {
    engine: "rust" as const,
    storage: AbsolutePath.make(path.join(tmp.path, "source.db")),
    location: { directory: AbsolutePath.make(path.join(tmp.path, "checkout")) },
  }
  const target = {
    engine: "rust" as const,
    storage: AbsolutePath.make(path.join(tmp.path, "destination.db")),
    location: { directory: AbsolutePath.make(path.join(tmp.path, "worktree")) },
  }
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: source.location })
      // A different source storage: the coordinator must not touch it.
      yield* database.db
        .update(SessionEnginePlacementTable)
        .set({
          engine: "rust",
          native_storage: AbsolutePath.make(path.join(tmp.path, "other.db")),
          location: source.location,
        })
        .where(eq(SessionEnginePlacementTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const { engine } = fakeEngine(sessionID)
      const exit = yield* SessionMoveCoordinator.moveRust({
        database: database.db,
        id: "move-1",
        sessionID,
        source,
        target,
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        engine,
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const placement = yield* SessionEnginePlacement.find(database.db, sessionID)
      if (placement?.engine !== "rust") throw new Error("placement must be rust")
      expect(placement.storage).toBe(AbsolutePath.make(path.join(tmp.path, "other.db")))
      const migration = yield* SessionMigration.find(database.db, "move-1")
      expect(migration).toBeUndefined()
    }),
  )
})
