import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect } from "effect"
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
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionStore } from "../src/session/store"
import { Prompt } from "../src/session/prompt"
import { EventV2 } from "../src/event"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { createHash } from "node:crypto"
import { SessionMigrationReverseCoordinator } from "../src/session/migration-reverse-coordinator"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  body: Effect.Effect<A, E, Database.Service | SessionV2.Service | EventV2.Service | SessionStore.Service>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, SessionV2.node, EventV2.node, SessionStore.node]), [
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

test("the reverse coordinator exports the delta, replays it and completes", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      yield* sessions.create({ id: sessionID, location: native(tmp.path).location })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1700000000000),
        messageID: SessionMessage.ID.create(),
        delivery: "steer",
        prompt: Prompt.make({ text: "base" }),
      })
      yield* database.db.run(
        sql`UPDATE session_engine_placement SET engine='rust', native_storage=${native(tmp.path).storage}, location=${JSON.stringify(native(tmp.path).location)} WHERE session_id=${sessionID}`,
      )
    }),
  )
  const deltaTimeline = [
    {
      id: SessionMessage.ID.make("msg_native_900"),
      type: "user",
      text: "native turn",
      time: { created: 1700000001000 },
    },
    {
      id: SessionMessage.ID.make("msg_native_901"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("openai") },
      content: [{ type: "text", id: "txt_native_901_0", text: "native reply" }],
      time: { created: 1700000002000, completed: 1700000002500 },
    },
  ] as unknown as SessionMessage.Message[]
  const bundle = JSON.stringify({
    id: "reverse",
    session_id: sessionID,
    bundle_sha256: "pending",
    baseline_seq: 2,
    timeline: deltaTimeline,
  })
  const bundleFile = AbsolutePath.make(path.join(tmp.path, "delta.json"))
  await Bun.write(bundleFile, bundle)
  const digest = createHash("sha256").update(bundle).digest("hex")
  await Bun.write(bundleFile, JSON.stringify({ ...JSON.parse(bundle), bundle_sha256: digest }))
  const engine = {
    exportDelta: (input: { importID: string; path: AbsolutePath }) =>
      Effect.succeed({
        id: input.importID,
        session_id: sessionID,
        bundle_sha256: digest,
        baseline_seq: 2,
        timeline: deltaTimeline as unknown[],
      }),
  }
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const pre = yield* SessionMigrationReverse.prepare(database.db, {
        id: "reverse",
        sessionID,
        native: native(tmp.path),
        bundleSHA256: digest,
        bundle: yield* Effect.promise(() => Bun.file(bundleFile).text()),
        sourceSeq: 2,
      }).pipe(Effect.exit)
      if (pre._tag === "Failure") console.error("PREPARE_CAUSE", String(pre.cause))
      expect(pre._tag).toBe("Success")
      const completedExit = yield* SessionMigrationReverseCoordinator.toTypeScript({
        database: database.db,
        id: "reverse",
        sessionID,
        native: native(tmp.path),
        bundleFile,
        agent: "build",
        model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("openai") },
        engine,
      }).pipe(Effect.exit)
      if (completedExit._tag === "Failure") console.error("COORD_CAUSE", String(completedExit.cause))
      const completed = completedExit._tag === "Success" ? completedExit.value : undefined
      expect(completed?.state).toBe("completed")
      expect((yield* SessionEnginePlacement.find(database.db, sessionID))?.engine).toBe("ts")
      const timeline = yield* store.timeline(sessionID)
      const texts = timeline.map((message) =>
        message.type === "assistant"
          ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
          : message.type === "user"
            ? message.text
            : "",
      )
      expect(texts).toEqual(["base", "native turn", "native reply"])
      expect((yield* SessionEnginePlacement.requireTypeScript(database.db, sessionID).pipe(Effect.exit))._tag).toBe(
        "Success",
      )
    }),
  )
})
