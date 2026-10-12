import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { FSUtil } from "../src/fs-util"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEnginePlacement } from "../src/session/engine-placement"
import { SessionRouting } from "../src/session/routing"
import { SessionTable } from "../src/session/sql"
import { SessionExecution } from "../src/session/execution"
import { EventTable } from "../src/event/sql"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  effect: Effect.Effect<A, E, Database.Service | SessionV2.Service | EventV2.Service | FSUtil.Service>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node, EventV2.node, FSUtil.node]), [
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

test("a Rust-owned Session resolves from its placement without any TS metadata", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const sessionID = SessionV2.ID.create()
      const placement = native(tmp.path)
      yield* SessionEnginePlacement.claim(database.db, { sessionID, placement })

      const resolution = yield* SessionRouting.resolve({ db: database.db, events, fs, sessionID })
      expect(resolution).toEqual({ type: "placed", engine: "rust", location: placement.location })
      // Resolving a native Session must not resurrect TS ownership or write the TS journal.
      expect(yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      expect(
        yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all(),
      ).toHaveLength(0)
    }),
  )
})

test("an unbound TS Session resolves from its row and adopts TS ownership", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const sessions = yield* SessionV2.Service
      const info = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })

      const resolution = yield* SessionRouting.resolve({ db: database.db, events, fs, sessionID: info.id })
      expect(resolution).toEqual({ type: "placed", engine: "ts", location: { directory: AbsolutePath.make(tmp.path) } })
    }),
  )
})

test("an unknown Session resolves to nothing", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const resolution = yield* SessionRouting.resolve({
        db: database.db,
        events,
        fs,
        sessionID: SessionV2.ID.create(),
      })
      expect(resolution).toEqual({ type: "unknown" })
    }),
  )
})

test("a TS placement without a Session row is still unknown", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const sessionID = SessionV2.ID.create()
      // A binding alone is not existence: the placement catalog records ownership,
      // but only a TS row or a Rust binding makes the Session addressable.
      yield* SessionEnginePlacement.claim(database.db, { sessionID, placement: { engine: "ts" } })
      expect(yield* SessionRouting.resolve({ db: database.db, events, fs, sessionID })).toEqual({ type: "unknown" })
    }),
  )
})

test("a Rust-owned Session whose Location vanished reports missing instead of relocating", async () => {
  await using tmp = await tmpdir()
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const sessionID = SessionV2.ID.create()
      const gone = path.join(tmp.path, "gone-location")
      yield* SessionEnginePlacement.claim(database.db, {
        sessionID,
        placement: {
          engine: "rust",
          storage: AbsolutePath.make(path.join(tmp.path, "native.db")),
          location: { directory: AbsolutePath.make(gone) },
        },
      })
      const resolution = yield* SessionRouting.resolve({ db: database.db, events, fs, sessionID })
      expect(resolution).toEqual({ type: "missing", directory: gone })
      // The native Session is never adopted into TS ownership by a failed resolution.
      expect(yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
    }),
  )
})
