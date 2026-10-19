import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { Global } from "../src/global"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEnginePlacement } from "../src/session/engine-placement"
import { SessionEnginePlacementTable } from "../src/session/engine-placement.sql"
import { SessionMigration } from "../src/session/migration"
import { SessionMigrationReverse } from "../src/session/migration-reverse"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(storage: string, body: Effect.Effect<A, E, Database.Service | SessionV2.Service>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, SessionV2.node]), [
          [Database.node, Database.layerFromPath(storage)],
          [SessionExecution.node, SessionExecution.noopLayer],
          [Global.node, Global.layerWith({ data: path.dirname(storage) })],
        ]),
      ),
      Effect.scoped,
    ),
  )

const native = (root: string) => ({
  engine: "rust" as const,
  storage: AbsolutePath.make(path.join(root, "native.db")),
  location: { directory: AbsolutePath.make(root) },
})

test("reverse migration flips authority back to TypeScript in one commit and is retry-safe", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      yield* sessions.create({ id: sessionID, location: native(tmp.path).location })
      yield* database.db.run(
        sql`UPDATE session_engine_placement SET engine='rust', native_storage=${native(tmp.path).storage}, location=${JSON.stringify(native(tmp.path).location)} WHERE session_id=${sessionID}`,
      )
    }),
  )
  const input = { id: "reverse", sessionID, native: native(tmp.path), bundleSHA256: "a".repeat(64) }
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect((yield* SessionMigrationReverse.switchToTypeScript(database.db, input).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      const prepared = yield* SessionMigrationReverse.prepare(database.db, {
        ...input,
        bundle: "{}",
        sourceSeq: 5,
      })
      expect(prepared.direction).toBe("rust_to_ts")
      expect(prepared.state).toBe("prepared")
      expect((yield* SessionMigrationReverse.complete(database.db, input).pipe(Effect.exit))._tag).toBe("Failure")
      const switched = yield* SessionMigrationReverse.switchToTypeScript(database.db, input)
      expect(switched.state).toBe("switched")
      const reverted = yield* SessionEnginePlacement.find(database.db, sessionID)
      expect(reverted?.engine).toBe("ts")
      expect((yield* SessionMigrationReverse.switchToTypeScript(database.db, input)).state).toBe("switched")
      expect((yield* SessionMigrationReverse.complete(database.db, input)).state).toBe("completed")
      expect((yield* SessionMigrationReverse.complete(database.db, input)).state).toBe("completed")
      expect((yield* SessionEnginePlacement.requireTypeScript(database.db, sessionID).pipe(Effect.exit))._tag).toBe(
        "Success",
      )
    }),
  )
})

test("reverse migration refuses a source that is not the current native placement", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: native(tmp.path).location })
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const failed = yield* SessionMigrationReverse.prepare(database.db, {
        id: "reverse",
        sessionID,
        native: native(tmp.path),
        bundleSHA256: "b".repeat(64),
        bundle: "{}",
        sourceSeq: 1,
      }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(yield* SessionMigration.find(database.db, "reverse")).toBeUndefined()
      expect((yield* SessionEnginePlacement.find(database.db, sessionID))?.engine).toBe("ts")
    }),
  )
})
