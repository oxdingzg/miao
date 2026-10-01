import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionBackfill } from "@miao/core/session/backfill"
import { SessionLegacyTables } from "@miao/core/session/legacy-tables"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionV1 } from "@miao/core/v1/session"
import { Session } from "@/session/session"
import { transcript } from "../../src/cli/cmd/export"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, MessageV2.node, SessionProjector.node, SessionStore.node])),
)

// `miao db compact` drops the legacy tables for good. Renaming them away has the
// same effect on every reader and lets the shared test database get them back.
const withoutLegacyTables = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* Effect.acquireUseRelease(
      Effect.all([
        database.db.run(sql.raw("ALTER TABLE part RENAME TO part_hidden")),
        database.db.run(sql.raw("ALTER TABLE message RENAME TO message_hidden")),
      ]).pipe(Effect.orDie),
      () => effect,
      () =>
        Effect.all([
          database.db.run(sql.raw("ALTER TABLE message_hidden RENAME TO message")),
          database.db.run(sql.raw("ALTER TABLE part_hidden RENAME TO part")),
        ]).pipe(Effect.orDie),
    )
  })

describe("export transcript", () => {
  it.instance("exports V1-shaped history from the projection once the legacy tables are gone", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const database = yield* Database.Service
      const info = yield* session.create({})
      const user = MessageID.ascending()
      const assistant = MessageID.ascending()
      yield* session.updateMessage({
        id: user,
        sessionID: info.id,
        role: "user",
        time: { created: 1_000 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt"), variant: "high" },
      } as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: user,
        type: "text",
        text: "list the files",
      })
      yield* session.updateMessage({
        id: assistant,
        sessionID: info.id,
        role: "assistant",
        time: { created: 2_000, completed: 3_000 },
        parentID: user,
        modelID: ModelV2.ID.make("gpt"),
        providerID: ProviderV2.ID.make("openai"),
        variant: "high",
        mode: "build",
        agent: "build",
        path: { cwd: info.directory, root: info.directory },
        cost: 0.5,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: assistant,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "a\nb",
          title: "ls",
          metadata: { exit: 0 },
          time: { start: 2_100, end: 2_200 },
        },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: assistant,
        type: "text",
        text: "two files",
      })

      // While the legacy tables exist the archive is the V1 rows, verbatim.
      expect(yield* transcript(info)).toEqual(yield* session.messages({ sessionID: info.id }))

      yield* SessionBackfill.backfill(database.db)
      const exported = yield* withoutLegacyTables(
        Effect.gen(function* () {
          expect(yield* SessionLegacyTables.present(database.db)).toBe(false)
          return yield* transcript(info)
        }),
      )

      expect(exported.map((message) => [message.info.id, message.info.role])).toEqual([
        [user, "user"],
        [assistant, "assistant"],
      ])
      const [asked, answered] = exported
      if (asked.info.role !== "user" || answered.info.role !== "assistant") throw new Error("unexpected roles")
      // The projection records no agent switch, so the selection comes from the reply.
      expect(asked.info.agent).toBe("build")
      expect(asked.info.model).toEqual({
        providerID: ProviderV2.ID.make("openai"),
        modelID: ModelV2.ID.make("gpt"),
        variant: "high",
      })
      expect(asked.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual(["list the files"])
      expect(answered.info.parentID).toBe(user)
      expect(answered.info.cost).toBe(0.5)
      expect(answered.info.finish).toBe("stop")
      expect(answered.parts.map((part) => part.type)).toEqual(["tool", "text"])
      const [tool, text] = answered.parts
      if (tool.type !== "tool" || tool.state.status !== "completed" || text.type !== "text")
        throw new Error("unexpected parts")
      expect(tool.callID).toBe("call_1")
      expect(tool.tool).toBe("bash")
      expect(tool.state.input).toEqual({ command: "ls" })
      expect(tool.state.output).toBe("a\nb")
      expect(text.text).toBe("two files")
      // `miao import` stores parts by id and reads them back in id order.
      const ids = exported.flatMap((message) => message.parts.map((part) => part.id))
      expect(ids.every((id) => id.startsWith("prt"))).toBe(true)
      expect(answered.parts.map((part) => part.id).toSorted()).toEqual(answered.parts.map((part) => part.id))
      expect(new Set(ids).size).toBe(ids.length)
    }),
  )
})
