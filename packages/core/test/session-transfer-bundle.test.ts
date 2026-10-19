import { expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { Blob } from "../src/blob"
import { Global } from "../src/global"
import { EventV2 } from "../src/event"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMigration } from "../src/session/migration"
import { SessionOwnership } from "../src/session/ownership"
import { SessionTransferBundle } from "../src/session/transfer-bundle"
import { SessionStore } from "../src/session/store"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  body: Effect.Effect<
    A,
    E,
    Database.Service | SessionV2.Service | EventV2.Service | SessionStore.Service | Blob.Service
  >,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([SessionV2.node, Database.node, EventV2.node, SessionStore.node, Blob.node]),
          [
            [Database.node, Database.layerFromPath(storage)],
            [SessionExecution.node, SessionExecution.noopLayer],
            [Global.node, Global.layerWith({ data: path.dirname(storage) })],
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

test("target rejection leaves the source unfrozen and releases its independent lease", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const rejected = yield* SessionTransferBundle.prepare({
        id: "rejected",
        sessionID,
        target: target(tmp.path),
        validate: (input) =>
          Effect.gen(function* () {
            expect(Hash.sha256(input.serialized)).toBe(input.digest)
            expect(yield* SessionMigration.find(database.db, "rejected")).toBeUndefined()
            return yield* Effect.fail(new Error("target cannot replay this context"))
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(yield* SessionMigration.active(database.db, sessionID)).toBeUndefined()
      yield* SessionOwnership.exclusive(storage, sessionID).pipe(Effect.scoped)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        delivery: "steer",
        prompt: Prompt.make({ text: "source remains usable" }),
      })
    }),
  )
})

test("old-writer progress during target validation invalidates the captured freeze", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const changed = yield* SessionTransferBundle.prepare({
        id: "changed",
        sessionID,
        target: target(tmp.path),
        validate: () =>
          events
            .publish(SessionEvent.Prompted, {
              sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: DateTime.makeUnsafe(1700000000000),
              delivery: "steer",
              prompt: Prompt.make({ text: "legacy writer advanced" }),
            })
            .pipe(Effect.asVoid),
      }).pipe(Effect.exit)
      expect(changed._tag).toBe("Failure")
      expect(yield* SessionMigration.find(database.db, "changed")).toBeUndefined()
      expect(yield* SessionMigration.active(database.db, sessionID)).toBeUndefined()
      const retry = yield* SessionTransferBundle.prepare({ id: "changed", sessionID, target: target(tmp.path) })
      expect(retry.bundle.timeline).toHaveLength(1)
    }),
  )
})

test("restart retry validates the identical durable payload rather than recapturing history", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
    }),
  )
  const validated: string[] = []
  const input = {
    id: "validated-retry",
    sessionID,
    target: target(tmp.path),
    validate: (payload: { serialized: string; digest: string }) =>
      Effect.sync(() => {
        validated.push(payload.serialized)
      }),
  }
  const first = await run(storage, SessionTransferBundle.prepare(input))
  const retry = await run(storage, SessionTransferBundle.prepare(input))
  expect(validated).toEqual([first.serialized, first.serialized])
  expect(retry.serialized).toBe(first.serialized)
})

test("corrupt artifact and unfinished provider work fail without a durable freeze", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const corruptID = SessionV2.ID.create()
  const unfinishedID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const blobs = yield* Blob.Service
      const events = yield* EventV2.Service
      yield* sessions.create({ id: corruptID, location: target(tmp.path).location })
      const artifact = yield* blobs.put({ bytes: new TextEncoder().encode("original") })
      yield* conversation(corruptID, Blob.refUri(artifact.hash))
      yield* Effect.promise(() => writeFile(path.join(tmp.path, Blob.DIRECTORY, artifact.hash), "corrupted"))
      yield* sessions.create({ id: unfinishedID, location: target(tmp.path).location })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: unfinishedID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.create(),
        agent: "build",
        model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.openai },
      })
    }),
  )
  for (const sessionID of [corruptID, unfinishedID]) {
    await run(
      storage,
      Effect.gen(function* () {
        const database = yield* Database.Service
        const result = yield* SessionTransferBundle.prepare({
          id: sessionID,
          sessionID,
          target: target(tmp.path),
        }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(yield* SessionMigration.find(database.db, sessionID)).toBeUndefined()
        expect(yield* SessionMigration.active(database.db, sessionID)).toBeUndefined()
      }),
    )
  }
})

const conversation = (sessionID: SessionV2.ID, uri: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const timestamp = DateTime.makeUnsafe(1700000000000)
    const messageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Prompted, {
      sessionID,
      timestamp,
      messageID,
      delivery: "steer",
      prompt: Prompt.make({ text: "Read the attachment", files: [{ uri, mime: "text/plain", name: "note.txt" }] }),
    })
    const base = { sessionID, timestamp, assistantMessageID: SessionMessage.ID.create() }
    yield* events.publish(SessionEvent.Step.Started, {
      ...base,
      agent: "build",
      model: {
        id: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.openai,
        variant: ModelV2.VariantID.make("high"),
      },
    })
    yield* events.publish(SessionEvent.Text.Started, { ...base, textID: "answer" })
    yield* events.publish(SessionEvent.Text.Ended, { ...base, textID: "answer", text: "Attachment read." })
    yield* events.publish(SessionEvent.Step.Ended, {
      ...base,
      finish: "stop",
      cost: 0.25,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    })
  })

test("semantic capture survives restart with canonical history, context and artifact bytes", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  const bytes = new TextEncoder().encode("attachment bytes\n")
  const original = await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const store = yield* SessionStore.Service
      const blobs = yield* Blob.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
      const artifact = yield* blobs.put({ bytes })
      yield* conversation(sessionID, Blob.refUri(artifact.hash))
      const timeline = yield* store.timeline(sessionID)
      const session = yield* store.get(sessionID)
      if (!session) throw new Error("Created Session disappeared")
      return {
        timeline: Schema.encodeSync(Schema.Array(SessionMessage.Message))(timeline),
        context: (yield* store.context(sessionID)).map((message) => message.id),
        session,
      }
    }),
  )
  const input = { id: "semantic-export", sessionID, target: target(tmp.path) }
  const exported = await run(storage, SessionTransferBundle.prepare(input))
  expect(Schema.encodeSync(Schema.Array(SessionMessage.Message))(exported.bundle.timeline)).toEqual(original.timeline)
  expect(exported.bundle.context_ids).toEqual(original.context)
  expect(exported.bundle.session).toEqual(original.session)
  expect(exported.bundle.artifacts).toEqual([
    { hash: Hash.sha256(bytes), base64: Buffer.from(bytes).toString("base64") },
  ])
  expect(exported.bundle.events.length).toBeGreaterThan(4)
  expect(Hash.sha256(exported.serialized)).toBe(exported.digest)
  const retry = await run(storage, SessionTransferBundle.prepare(input))
  expect(retry.serialized).toBe(exported.serialized)
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect((yield* SessionMigration.find(database.db, input.id))?.bundle).toBe(exported.serialized)
      const changed = yield* SessionTransferBundle.prepare({
        ...input,
        target: { ...input.target, storage: AbsolutePath.make(path.join(tmp.path, "other.db")) },
      }).pipe(Effect.exit)
      expect(changed._tag).toBe("Failure")
    }),
  )
})

test("missing attachment fails before freeze and permits subsequent source work", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
      yield* conversation(sessionID, Blob.refUri("0".repeat(64)))
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const failed = yield* SessionTransferBundle.prepare({ id: "missing", sessionID, target: target(tmp.path) }).pipe(
        Effect.exit,
      )
      expect(failed._tag).toBe("Failure")
      expect(yield* SessionMigration.active(database.db, sessionID)).toBeUndefined()
      expect(yield* SessionMigration.find(database.db, "missing")).toBeUndefined()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        delivery: "steer",
        prompt: Prompt.make({ text: "still writable" }),
      })
    }),
  )
})

test("live source lease and pending inbox prevent semantic freeze", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "source.db")
  const sessionID = SessionV2.ID.create()
  const input = { id: "busy", sessionID, target: target(tmp.path) }
  await run(
    storage,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
      expect((yield* SessionTransferBundle.prepare(input).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* SessionMigration.find(database.db, input.id)).toBeUndefined()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        delivery: "queue",
        prompt: Prompt.make({ text: "pending" }),
      })
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect((yield* SessionTransferBundle.prepare(input).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* SessionMigration.find(database.db, input.id)).toBeUndefined()
    }),
  )
})
