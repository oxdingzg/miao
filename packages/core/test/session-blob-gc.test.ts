import { describe, expect } from "bun:test"
import { join } from "path"
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
import { SessionBlobGc } from "@miao/core/session/blob-gc"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

type DatabaseService = Database.Interface["db"]

const withEnv = <A, E, R>(
  body: (input: { db: DatabaseService; blob: Blob.Interface; directory: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Blob.node, FSUtil.node]), [
        [Global.node, global],
      ])
      return Effect.gen(function* () {
        return yield* body({
          db: (yield* Database.Service).db,
          blob: yield* Blob.Service,
          directory: join(tmp.path, Blob.DIRECTORY),
        })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const sessionID = SessionSchema.ID.make("ses_blob_gc")

describe("SessionBlobGc", () => {
  it.live("keeps referenced blobs and deletes unreferenced ones", () =>
    withEnv(({ db, blob, directory }) =>
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

        const message = yield* blob.put({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" })
        const event = yield* blob.put({ bytes: new Uint8Array([4, 5, 6]), mime: "image/png" })
        const orphan = yield* blob.put({ bytes: new Uint8Array([7, 8, 9]), mime: "image/png" })

        yield* db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make("msg_ref"),
            session_id: sessionID,
            type: "user",
            seq: 0,
            time_created: 1,
            data: {
              type: "user",
              time: { created: 1 },
              text: "x",
              files: [{ uri: Blob.refUri(message.hash), mime: "image/png" }],
            } as never,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make("evt_ref"),
            aggregate_id: sessionID,
            seq: 0,
            type: "session.next.tool.success.1",
            data: { content: [{ type: "file", uri: Blob.refUri(event.hash), mime: "image/png" }] },
          })
          .run()
          .pipe(Effect.orDie)

        const dry = yield* SessionBlobGc.sweep({ blob, db, directory, dryRun: true, graceMs: 0 })
        expect(dry).toMatchObject({ orphans: 1, deleted: 0 })
        expect(dry.referenced).toBeGreaterThanOrEqual(2)
        expect(yield* blob.has(orphan.hash)).toBe(true)

        const result = yield* SessionBlobGc.sweep({ blob, db, directory, graceMs: 0 })
        expect(result).toMatchObject({ orphans: 1, deleted: 1 })
        expect(yield* blob.has(orphan.hash)).toBe(false)
        expect(yield* blob.has(message.hash)).toBe(true)
        expect(yield* blob.has(event.hash)).toBe(true)
      }),
    ),
  )

  it.live("keeps an unreferenced blob inside the grace window", () =>
    withEnv(({ db, blob, directory }) =>
      Effect.gen(function* () {
        const fresh = yield* blob.put({ bytes: new Uint8Array([9]), mime: "image/png" })
        const result = yield* SessionBlobGc.sweep({ blob, db, directory, graceMs: 60_000 })
        expect(result.orphans).toBe(0)
        expect(yield* blob.has(fresh.hash)).toBe(true)
      }),
    ),
  )
})
