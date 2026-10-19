import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMigration } from "../src/session/migration"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionInputTable, SessionMessageTable } from "../src/session/sql"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  body: Effect.Effect<A, E, Database.Service | SessionV2.Service | EventV2.Service>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node, EventV2.node]), [
          [Database.node, Database.layerFromPath(storage)],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )

const target = (root: string) => ({
  engine: "rust" as const,
  storage: AbsolutePath.make(path.join(root, "native.db")),
  location: { directory: AbsolutePath.make(root) },
})

test("source freeze persists across restart, rejects conflicting retries and releases only on abort", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "product.db")
  const sessionID = SessionV2.ID.create()
  const staged = await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ id: sessionID, location: target(tmp.path).location })
      const input = {
        id: "transfer",
        sessionID,
        target: target(tmp.path),
        bundleSHA256: "a".repeat(64),
        sourceSeq: yield* EventV2.latestSequence(database.db, sessionID),
      }
      const frozen = yield* SessionMigration.freeze(database.db, input)
      expect(yield* SessionMigration.freeze(database.db, input)).toEqual(frozen)
      for (const conflicting of [
        { ...input, id: "second-transfer" },
        { ...input, bundleSHA256: "b".repeat(64) },
        { ...input, target: { ...input.target, storage: AbsolutePath.make(path.join(tmp.path, "other.db")) } },
        { ...input, sourceSeq: input.sourceSeq + 1 },
      ])
        expect((yield* SessionMigration.freeze(database.db, conflicting).pipe(Effect.exit))._tag).toBe("Failure")
      return frozen
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      expect(yield* SessionMigration.active(database.db, sessionID)).toEqual(staged)
      const before = yield* database.db.select().from(EventTable).all()
      const denied = yield* Effect.all([
        sessions.prompt({ sessionID, prompt: { text: "frozen" }, resume: false }).pipe(Effect.exit),
        sessions.rename({ sessionID, title: "wrong writer" }).pipe(Effect.exit),
        sessions.resume(sessionID).pipe(Effect.exit),
      ])
      expect(denied.every((outcome) => outcome._tag === "Failure")).toBe(true)
      expect(yield* database.db.select().from(EventTable).all()).toEqual(before)
      expect(yield* database.db.select().from(SessionInputTable).all()).toHaveLength(0)
      const aborted = yield* SessionMigration.abort(database.db, { id: "transfer", sessionID })
      expect(aborted.state).toBe("aborted")
      expect(yield* SessionMigration.abort(database.db, { id: "transfer", sessionID })).toEqual(aborted)
      expect(yield* SessionMigration.active(database.db, sessionID)).toBeUndefined()
      const input = {
        id: "transfer",
        sessionID,
        target: target(tmp.path),
        bundleSHA256: "a".repeat(64),
        sourceSeq: staged.source_seq,
      }
      expect((yield* SessionMigration.freeze(database.db, input).pipe(Effect.exit))._tag).toBe("Failure")
      yield* sessions.prompt({ sessionID, prompt: { text: "after abort" }, resume: false })
      expect(yield* database.db.select().from(SessionInputTable).all()).toHaveLength(1)
      // A new transition must capture the newly admitted input too.
      expect(
        (yield* SessionMigration.freeze(database.db, { ...input, id: "stale-new-transfer" }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
    }),
  )
})

test.each(["admit", "cancel", "promote"] as const)(
  "freeze wins the race after %s preflight without partial event projection",
  async (operation) => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "product.db"),
      Effect.gen(function* () {
        const database = yield* Database.Service
        const sessions = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const session = yield* sessions.create({ location: target(tmp.path).location })
        const id = SessionMessage.ID.create()
        const input = {
          id,
          sessionID: session.id,
          prompt: Prompt.make({ text: "queued source input" }),
          delivery: "steer" as const,
        }
        if (operation !== "admit") yield* SessionInput.admit(database.db, events, input)
        const before = yield* database.db.select().from(EventTable).all()
        const transition = {
          id: "racing-transfer",
          sessionID: session.id,
          target: target(tmp.path),
          bundleSHA256: "a".repeat(64),
          sourceSeq: yield* EventV2.latestSequence(database.db, session.id),
        }
        // Decorate the real event publisher to stage a competing transfer between
        // preflight and the actual event transaction. No projection is mocked.
        const racing: EventV2.Interface = {
          ...events,
          publish: (definition, data, options) =>
            SessionMigration.freeze(database.db, transition).pipe(
              Effect.orDie,
              Effect.andThen(events.publish(definition, data, options)),
            ),
        }
        const action =
          operation === "admit"
            ? SessionInput.admit(database.db, racing, input).pipe(Effect.asVoid)
            : operation === "cancel"
              ? SessionInput.cancel(database.db, racing, { sessionID: session.id, id }).pipe(Effect.asVoid)
              : SessionInput.promoteSteers(database.db, racing, session.id, Number.MAX_SAFE_INTEGER).pipe(Effect.asVoid)
        expect((yield* action.pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* database.db.select().from(EventTable).all()).toEqual(before)
        expect(yield* database.db.select().from(SessionMessageTable).all()).toHaveLength(0)
        const pending = yield* SessionInput.find(database.db, id)
        if (operation === "admit") expect(pending).toBeUndefined()
        if (operation !== "admit") {
          expect(pending).toBeDefined()
          expect(pending?.promotedSeq).toBeUndefined()
        }
        expect((yield* SessionMigration.active(database.db, session.id))?.id).toBe("racing-transfer")
      }),
    )
  },
)
