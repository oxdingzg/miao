import { expect, test } from "bun:test"
import path from "node:path"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionMigrationReverse } from "../src/session/migration-reverse"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { Prompt } from "../src/session/prompt"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(
  storage: string,
  directory: string,
  body: Effect.Effect<A, E, Database.Service | SessionV2.Service | EventV2.Service | SessionStore.Service>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, SessionV2.node, EventV2.node, SessionStore.node]), [
          [Database.node, Database.layerFromPath(storage)],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )

const location = (root: string) => ({ directory: AbsolutePath.make(root) })

test("restores exported durable events into an empty TypeScript aggregate", async () => {
  await using source = await tmpdir()
  const sourceDB = path.join(source.path, "source.db")
  const sessionID = SessionV2.ID.create()
  const original = await run(
    sourceDB,
    source.path,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      yield* sessions.create({ id: sessionID, location: location(source.path) })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1700000000000),
        messageID: SessionMessage.ID.create(),
        delivery: "steer",
        prompt: Prompt.make({ text: "restored prompt" }),
      })
      const session = yield* store.get(sessionID)
      const row = yield* database.db
        .select({ workspaceID: SessionTable.workspace_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      const timeline = yield* store.timeline(sessionID)
      const rows = yield* database.db
        .select({
          id: EventTable.id,
          aggregateID: EventTable.aggregate_id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: EventTable.data,
        })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      return {
        timeline: Schema.encodeSync(Schema.Array(SessionMessage.Message))(timeline),
        rows,
        catalog: {
          projectID: session!.projectID,
          workspaceID: row!.workspaceID ?? session!.projectID,
          directory: session!.location.directory,
        },
      }
    }),
  )

  await using target = await tmpdir()
  const targetDB = path.join(target.path, "target.db")
  await run(
    targetDB,
    target.path,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const restored = yield* SessionMigrationReverse.importHistory(database.db, {
        sessionID,
        catalog: original.catalog,
        events: original.rows.map((row) => ({
          id: row.id,
          aggregateID: row.aggregateID,
          seq: row.seq,
          type: row.type,
          data: row.data,
        })),
      })
      expect(restored.id).toBe(sessionID)
      const timeline = yield* store.timeline(sessionID)
      expect(Schema.encodeSync(Schema.Array(SessionMessage.Message))(timeline)).toEqual(original.timeline)
    }),
  )
})
