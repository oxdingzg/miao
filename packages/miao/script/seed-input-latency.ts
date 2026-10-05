import path from "node:path"
import { existsSync } from "node:fs"
import { DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { EventSequenceTable } from "@miao/core/event/sql"
import { SessionCreate } from "@miao/core/session-create"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { AbsolutePath, Agent, Location, Model, Provider, Session, SessionMessage } from "@miao/schema"

const file = process.env.MIAO_DB
if (!file || !path.isAbsolute(file) || existsSync(file) || !process.argv[2])
  throw new Error("Set MIAO_DB to a new absolute fixture database path and supply its directory")

const sessionID = Session.ID.make("ses_input_latency_fixture")
const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") })
const encode = Schema.encodeSync(SessionMessage.Message)

// Only storage and projection services: no model execution, provider connection,
// HTTP server or second database runtime is needed to build this artificial fixture.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const creation = yield* SessionCreate.Service
      const database = yield* Database.Service
      yield* creation.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        model,
        location: Location.Ref.make({ directory: AbsolutePath.make(path.resolve(process.argv[2])) }),
      })
      const rows = Array.from({ length: 400 }, (_, index) => {
        const time = DateTime.makeUnsafe(1_700_000_000_000 + index * 1000)
        const message =
          index % 2 === 0
            ? SessionMessage.User.make({
                type: "user",
                id: SessionMessage.ID.make(`msg_fixture_${index}`),
                text: `Turn ${index / 2}: inspect the fixed workload`,
                time: { created: time },
              })
            : SessionMessage.Assistant.make({
                type: "assistant",
                id: SessionMessage.ID.make(`msg_fixture_${index}`),
                agent: "build",
                model,
                content: [
                  {
                    type: "text",
                    id: `text_${index}`,
                    text: `Response ${index}. ${"Fixed workload text. ".repeat(100)}`,
                  },
                  {
                    type: "tool",
                    id: `call_${index}`,
                    name: "bash",
                    state: {
                      status: "completed",
                      input: { command: "echo fixture" },
                      structured: {},
                      content: [{ type: "text", text: "Fixture output\n".repeat(500) }],
                    },
                    time: { created: time, completed: time },
                  },
                ],
                finish: "stop",
                time: { created: time, completed: time },
              })
        const encoded = encode(message)
        return {
          id: SessionMessage.ID.make(encoded.id),
          session_id: sessionID,
          type: encoded.type,
          seq: index + 2,
          time_created: DateTime.toEpochMillis(time),
          data: encoded,
        }
      })
      // This is a rendering benchmark fixture, not an event-replay test: the
      // prepared messages are deliberately inserted into the projection directly.
      yield* database.db.insert(SessionMessageTable).values(rows).run().pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ title: "Input latency fixed workload" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(EventSequenceTable)
        .set({ seq: rows.length + 1 })
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      console.log(JSON.stringify({ sessionID, messages: rows.length }))
    }),
  ).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionCreate.node])),
    ),
  ),
)
