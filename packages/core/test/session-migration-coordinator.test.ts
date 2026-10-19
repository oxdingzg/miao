import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { Blob } from "../src/blob"
import { Global } from "../src/global"
import { EventV2 } from "../src/event"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMigration } from "../src/session/migration"
import { SessionMigrationCoordinator } from "../src/session/migration-coordinator"
import { SessionEnginePlacement } from "../src/session/engine-placement"
import { SessionStore } from "../src/session/store"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { Snapshot } from "../src/snapshot"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  directory: string,
  body: Effect.Effect<
    A,
    E,
    Database.Service | SessionV2.Service | EventV2.Service | SessionStore.Service | Blob.Service | Snapshot.Service
  >,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([SessionV2.node, Database.node, EventV2.node, SessionStore.node, Blob.node, Snapshot.node]),
          [
            [Database.node, Database.layerFromPath(storage)],
            [SessionExecution.node, SessionExecution.noopLayer],
            [Global.node, Global.layerWith({ data: path.dirname(storage) })],
            [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
          ],
        ),
      ),
      Effect.scoped,
    ),
  )

const target = (root: string) => ({
  engine: "rust" as const,
  storage: AbsolutePath.make(path.join(root, "native.db")),
  location: { directory: AbsolutePath.make(root) },
})

function engine(sessionID: SessionV2.ID, script: { stage?: "fail"; activate?: "fail"; wrongDigest?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    engine: {
      validate: () => Effect.sync(() => void calls.push("validate")),
      stage: (input: { importID: string; bundleSHA256: string }) => {
        calls.push("stage")
        if (script.stage === "fail") return Effect.fail(new Error("stage rejected"))
        return Effect.succeed({
          id: input.importID,
          session_id: sessionID,
          bundle_sha256: script.wrongDigest ? "0".repeat(64) : input.bundleSHA256,
          state: "staged",
        })
      },
      activate: (input: { importID: string; bundleSHA256: string }) => {
        calls.push("activate")
        if (script.activate === "fail") return Effect.fail(new Error("activation down"))
        return Effect.succeed({
          id: input.importID,
          session_id: sessionID,
          bundle_sha256: input.bundleSHA256,
          state: "active",
        })
      },
    },
  }
}

async function source() {
  const tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    tmp.path,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
    }),
  )
  return { tmp, storage, sessionID }
}

test("migration coordinator drives freeze, native stage, placement cutover and activation", async () => {
  const { tmp, storage, sessionID } = await source()
  await using _ = tmp
  const recording = engine(sessionID)
  await run(
    storage,
    tmp.path,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const completed = yield* SessionMigrationCoordinator.toNative({
        database: database.db,
        id: "coordinated",
        sessionID,
        target: target(tmp.path),
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        identity: { protocol: "openai-chat", model: "fixture" },
        engine: recording.engine,
      })
      expect(recording.calls).toEqual(["validate", "stage", "activate"])
      expect(completed.state).toBe("completed")
      expect(yield* SessionEnginePlacement.find(database.db, sessionID)).toEqual(target(tmp.path))
      expect(completed.bundle).toBe(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "bundle.json")).text()))
      expect((yield* SessionEnginePlacement.requireTypeScript(database.db, sessionID).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
    }),
  )
})

test("stage failure releases the durable source freeze and reports the native error", async () => {
  const { tmp, storage, sessionID } = await source()
  await using _ = tmp
  const recording = engine(sessionID, { stage: "fail" })
  await run(
    storage,
    tmp.path,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const failed = yield* SessionMigrationCoordinator.toNative({
        database: database.db,
        id: "stage-fail",
        sessionID,
        target: target(tmp.path),
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        identity: { protocol: "openai-chat", model: "fixture" },
        engine: recording.engine,
      }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(recording.calls).toEqual(["validate", "stage"])
      expect((yield* SessionMigration.find(database.db, "stage-fail"))?.state).toBe("aborted")
      expect(yield* SessionMigration.active(database.db, sessionID)).toBeUndefined()
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        delivery: "steer",
        prompt: Prompt.make({ text: "source remains editable" }),
      })
    }),
  )
})

test("activation failure keeps the switched placement and resumes without restaging", async () => {
  const { tmp, storage, sessionID } = await source()
  await using _ = tmp
  await run(
    storage,
    tmp.path,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const failing = engine(sessionID, { activate: "fail" })
      const input = {
        database: database.db,
        id: "resume",
        sessionID,
        target: target(tmp.path),
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        identity: { protocol: "openai-chat", model: "fixture" },
      }
      const failed = yield* SessionMigrationCoordinator.toNative({ ...input, engine: failing.engine }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(failing.calls).toEqual(["validate", "stage", "activate"])
      expect((yield* SessionMigration.find(database.db, "resume"))?.state).toBe("switched")
      expect(yield* SessionEnginePlacement.find(database.db, sessionID)).toEqual(target(tmp.path))
      const recovering = engine(sessionID)
      const completed = yield* SessionMigrationCoordinator.toNative({ ...input, engine: recovering.engine })
      expect(recovering.calls).toEqual(["activate"])
      expect(completed.state).toBe("completed")
    }),
  )
})

test("a mismatched stage receipt aborts the freeze instead of advancing", async () => {
  const { tmp, storage, sessionID } = await source()
  await using _ = tmp
  const recording = engine(sessionID, { wrongDigest: true })
  await run(
    storage,
    tmp.path,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const failed = yield* SessionMigrationCoordinator.toNative({
        database: database.db,
        id: "receipt",
        sessionID,
        target: target(tmp.path),
        bundleFile: AbsolutePath.make(path.join(tmp.path, "bundle.json")),
        productDatabase: AbsolutePath.make(storage),
        identity: { protocol: "openai-chat", model: "fixture" },
        engine: recording.engine,
      }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect((yield* SessionMigration.find(database.db, "receipt"))?.state).toBe("aborted")
      expect((yield* SessionEnginePlacement.find(database.db, sessionID))?.engine).toBe("ts")
    }),
  )
})
