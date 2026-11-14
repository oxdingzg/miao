import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Blob } from "@miao/core/blob"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { EventSequenceTable, EventTable } from "@miao/core/event/sql"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionBlobMigrate } from "@miao/core/session/blob-migrate"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionMessage } from "@miao/core/session/message"
import { SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

type DatabaseService = Database.Interface["db"]

const withEnv = <A, E, R>(body: (input: { db: DatabaseService; blob: Blob.Interface }) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Blob.node, FSUtil.node]), [
        [Global.node, global],
      ])
      return Effect.gen(function* () {
        return yield* body({ db: (yield* Database.Service).db, blob: yield* Blob.Service })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const sessionID = SessionSchema.ID.make("ses_blob_migrate")
const bigUri = () => `data:image/png;base64,${Buffer.alloc(200 * 1024, 9).toString("base64")}`
const bigStructured = () => ({
  encoding: "base64",
  mime: "image/png",
  content: Buffer.alloc(200 * 1024, 7).toString("base64"),
})

const seed = (db: DatabaseService) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1 }).run().pipe(Effect.orDie)
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.make("msg_user"),
          session_id: sessionID,
          type: "user",
          seq: 0,
          time_created: 1,
          data: {
            time: { created: 1 },
            text: "hi",
            files: [{ uri: bigUri(), mime: "image/png", name: "big.png" }],
          } as never,
        },
        {
          id: SessionMessage.ID.make("msg_assistant"),
          session_id: sessionID,
          type: "assistant",
          seq: 1,
          time_created: 2,
          data: {
            time: { created: 2 },
            content: [
              {
                type: "tool",
                id: "c1",
                name: "read",
                state: {
                  status: "completed",
                  input: {},
                  structured: bigStructured(),
                  content: [{ type: "file", uri: bigUri(), mime: "image/png", name: "shot.png" }],
                },
              },
            ],
          } as never,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values([
        {
          id: EventV2.ID.make("evt_prompt"),
          aggregate_id: sessionID,
          seq: 0,
          type: "session.next.prompt.admitted.1",
          data: {
            sessionID,
            messageID: "msg_user",
            prompt: { text: "hi", files: [{ uri: bigUri(), mime: "image/png", name: "big.png" }] },
          },
        },
        {
          id: EventV2.ID.make("evt_tool"),
          aggregate_id: sessionID,
          seq: 1,
          type: "session.next.tool.success.1",
          data: {
            sessionID,
            structured: bigStructured(),
            content: [{ type: "file", uri: bigUri(), mime: "image/png", name: "shot.png" }],
          },
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

describe("SessionBlobMigrate", () => {
  it.live("dry-run reports without writing, then migrates and is idempotent", () =>
    withEnv(({ db, blob }) =>
      Effect.gen(function* () {
        yield* seed(db)

        const dry = yield* SessionBlobMigrate.migrate(blob, db, { dryRun: true })
        expect(dry).toMatchObject({ messages: 2, events: 2 })
        expect(dry.bytes).toBeGreaterThan(0)

        const before = yield* db
          .select({ data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_user")))
          .get()
          .pipe(Effect.orDie)
        expect((before?.data as unknown as { files: { uri: string }[] }).files[0]!.uri.startsWith("data:")).toBe(true)

        const result = yield* SessionBlobMigrate.migrate(blob, db)
        expect(result).toMatchObject({ messages: 2, events: 2 })

        const user = yield* db
          .select({ data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_user")))
          .get()
          .pipe(Effect.orDie)
        const userUri = (user?.data as unknown as { files: { uri: string }[] }).files[0]!.uri
        expect(Blob.isRef(userUri)).toBe(true)
        expect(yield* blob.has(Blob.hashOf(userUri) ?? "")).toBe(true)

        const assistant = yield* db
          .select({ data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_assistant")))
          .get()
          .pipe(Effect.orDie)
        const toolState = (assistant?.data as unknown as { content: { state: { content: { uri: string }[] } }[] })
          .content[0]!.state
        expect(Blob.isRef(toolState.content[0]!.uri)).toBe(true)

        // The raw structured output's oversized content moves out of line too.
        const toolEvent = yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.id, EventV2.ID.make("evt_tool")))
          .get()
          .pipe(Effect.orDie)
        const structured = (toolEvent?.data as unknown as { structured: { content: string; contentRef?: boolean } })
          .structured
        expect(structured.contentRef).toBe(true)
        expect(Blob.isRef(structured.content)).toBe(true)

        // A second pass finds nothing left inline.
        expect(yield* SessionBlobMigrate.migrate(blob, db)).toMatchObject({ messages: 0, events: 0 })
      }),
    ),
  )
})
