import { EventTable } from "../src/event/sql"
import placementMigration from "../src/database/migration/20261011151147_session_engine_placement"
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEnginePlacement } from "../src/session/engine-placement"
import { SessionEnginePlacementTable } from "../src/session/engine-placement.sql"
import { SessionTable } from "../src/session/sql"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service | SessionV2.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node]), [
          [Database.node, Database.layerFromPath(storage)],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )

const native = (directory: string) => ({
  engine: "rust" as const,
  storage: AbsolutePath.make(path.join(directory, "native.db")),
  location: { directory: AbsolutePath.make(directory) },
})

test("native binding survives reopen, reconciles exact retries, and rejects changed facts", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  const placement = native(tmp.path)
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* SessionEnginePlacement.claim(database.db, { sessionID, placement })).toEqual(placement)
      expect(yield* SessionEnginePlacement.claim(database.db, { sessionID, placement })).toEqual(placement)
      expect(yield* database.db.select().from(SessionTable).all()).toHaveLength(0)
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* SessionEnginePlacement.find(database.db, sessionID)).toEqual(placement)
      for (const other of [
        { engine: "ts" as const },
        { ...placement, storage: AbsolutePath.make(path.join(tmp.path, "other.db")) },
        { ...placement, location: { directory: AbsolutePath.make(path.join(tmp.path, "other")) } },
      ]) {
        const result = yield* SessionEnginePlacement.claim(database.db, { sessionID, placement: other }).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(result)).toBe(true)
      }
      expect(yield* SessionEnginePlacement.find(database.db, sessionID)).toEqual(placement)
    }),
  )
})

test("real TS Session creation binds TS and cannot create over a native binding", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const info = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      expect(yield* SessionEnginePlacement.find(database.db, info.id)).toEqual({ engine: "ts" })
      const denied = yield* SessionEnginePlacement.claim(database.db, {
        sessionID: info.id,
        placement: native(tmp.path),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      const sessionID = SessionV2.ID.create()
      yield* SessionEnginePlacement.claim(database.db, { sessionID, placement: native(tmp.path) })
      const created = yield* sessions
        .create({ id: sessionID, location: { directory: AbsolutePath.make(tmp.path) } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(created)).toBe(true)
      expect(yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      expect(yield* SessionEnginePlacement.find(database.db, sessionID)).toEqual(native(tmp.path))
      expect(
        yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all(),
      ).toHaveLength(0)
    }),
  )
})

test("a failed enclosing transaction rolls a binding back", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.create()
      yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            yield* SessionEnginePlacement.claim(database.db, { sessionID, placement: native(tmp.path) })
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.exit)
      expect(yield* database.db.select().from(SessionEnginePlacementTable).all()).toHaveLength(0)
    }),
  )
})

test("racing TS creation and native claim leave exactly one durable authority", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.create()
      const outcomes = yield* Effect.all(
        [
          sessions.create({ id: sessionID, location: { directory: AbsolutePath.make(tmp.path) } }).pipe(Effect.exit),
          SessionEnginePlacement.claim(database.db, { sessionID, placement: native(tmp.path) }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1)
      const binding = yield* SessionEnginePlacement.find(database.db, sessionID)
      const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
      expect(binding?.engine).toBe(row ? "ts" : "rust")
    }),
  )
})

test("upgrade pins existing TS sessions without copying transcript facts", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const info = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const before = yield* database.db.select().from(EventTable).all()
      yield* database.db.run(sql`DROP TABLE session_engine_placement`)
      yield* database.db.transaction((tx) => placementMigration.up(tx))
      expect(yield* SessionEnginePlacement.find(database.db, info.id)).toEqual({ engine: "ts" })
      expect(yield* database.db.select().from(EventTable).all()).toEqual(before)
    }),
  )
})

test("listing returns only native bindings with their owning storage", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const nativeSession = SessionV2.ID.create()
  const tsSession = SessionV2.ID.create()
  const placement = native(tmp.path)
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* SessionEnginePlacement.claim(database.db, { sessionID: nativeSession, placement })
      yield* SessionEnginePlacement.claim(database.db, { sessionID: tsSession, placement: { engine: "ts" } })
      const listed = yield* SessionEnginePlacement.list(database.db)
      expect(listed.map((entry) => entry.sessionID)).toEqual([nativeSession])
      expect(listed[0]?.storage).toBe(placement.storage)
      expect(listed[0]?.location).toEqual(placement.location)
    }),
  )
})

test("listing excludes native catalog projections before limit and anchors", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const oldest = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const middle = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const projected = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      for (const [info, time] of [
        [oldest, 100],
        [middle, 200],
        [projected, 300],
      ] as const) {
        yield* database.db.update(SessionTable).set({ time_created: time }).where(eq(SessionTable.id, info.id)).run()
      }
      // Seed the dual projection produced by native creation: the catalog row
      // remains metadata only while placement makes the engine authoritative.
      yield* database.db
        .update(SessionEnginePlacementTable)
        .set({
          engine: "rust",
          native_storage: native(tmp.path).storage,
          location: native(tmp.path).location,
        })
        .where(eq(SessionEnginePlacementTable.session_id, projected.id))
        .run()
      // Imported TS sessions may have no synthesized binding and remain visible.
      yield* database.db
        .delete(SessionEnginePlacementTable)
        .where(eq(SessionEnginePlacementTable.session_id, oldest.id))
        .run()
      expect((yield* sessions.list({ order: "desc", limit: 1 })).map((info) => info.id)).toEqual([middle.id])
      expect((yield* sessions.list({ order: "asc", limit: 1 })).map((info) => info.id)).toEqual([oldest.id])
      expect(
        (yield* sessions.list({
          order: "desc",
          limit: 1,
          anchor: { id: middle.id, time: 200, direction: "next" },
        })).map((info) => info.id),
      ).toEqual([oldest.id])
      expect(
        (yield* sessions.list({
          order: "desc",
          limit: 1,
          anchor: { id: oldest.id, time: 100, direction: "previous" },
        })).map((info) => info.id),
      ).toEqual([middle.id])
      expect(
        (yield* sessions.list({ directory: AbsolutePath.make(tmp.path), limit: 10 })).map((info) => info.id),
      ).not.toContain(projected.id)
    }),
  )
})
