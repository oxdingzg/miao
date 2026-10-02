import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionBackfill } from "@miao/core/session/backfill"
import { SessionLegacyTables } from "@miao/core/session/legacy-tables"
import { SessionSchema } from "@miao/core/session/schema"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { InstanceRef } from "@/effect/instance-ref"
import { archive } from "../../src/cli/cmd/export"
import { importArchive } from "../../src/cli/cmd/import"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, SessionStore.node])))

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

const model = { providerID: "openai", modelID: "gpt", variant: "high" }
const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }

/** A legacy V1 transcript: a multi-step reply, a failed reply, and a manual compaction. */
const legacy = (directory: string) => {
  const assistant = (id: string, parentID: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: "assistant",
    time: { created: Number(id.slice(-1)) * 1_000, completed: Number(id.slice(-1)) * 1_000 + 500 },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    variant: model.variant,
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0.5,
    tokens,
    finish: "stop",
    ...extra,
  })
  const user = (id: string) => ({
    id,
    role: "user",
    time: { created: Number(id.slice(-1)) * 1_000 },
    agent: "build",
    model,
  })
  const step = (n: number) => [
    { type: "step-start", snapshot: `tree-${n}` },
    {
      type: "step-finish",
      reason: "stop",
      snapshot: `tree-${n + 1}`,
      cost: 0.25,
      tokens,
    },
  ]
  return [
    { info: user("msg_legacy_1"), parts: [{ type: "text", text: "list the files" }] },
    {
      info: assistant("msg_legacy_2", "msg_legacy_1"),
      parts: [
        step(0)[0],
        { type: "text", text: "looking" },
        {
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
        },
        step(0)[1],
        { type: "patch", hash: "tree-0", files: [`${directory}/a.ts`] },
        step(1)[0],
        { type: "text", text: "two files" },
        step(1)[1],
      ],
    },
    {
      info: user("msg_legacy_3"),
      parts: [
        { type: "text", text: "delegate " },
        { type: "subtask", prompt: "look around", description: "explore", agent: "explore" },
      ],
    },
    {
      info: assistant("msg_legacy_4", "msg_legacy_3", {
        error: { name: "APIError", data: { message: "rate limited", isRetryable: true } },
        finish: undefined,
      }),
      parts: [{ type: "text", text: "partial" }],
    },
    { info: user("msg_legacy_5"), parts: [{ type: "compaction", auto: false }] },
    {
      info: assistant("msg_legacy_6", "msg_legacy_5", { agent: "compaction", mode: "compaction", summary: true }),
      parts: [...step(2).slice(0, 1), { type: "text", text: "we listed files" }, ...step(2).slice(1)],
    },
  ]
}

const createLegacySession = Effect.fn("test.createLegacySession")(function* (id: string) {
  const { db } = yield* Database.Service
  const ctx = yield* InstanceRef
  if (!ctx) throw new Error("no instance")
  const sessionID = SessionSchema.ID.make(id)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ctx.project.id,
      slug: id,
      directory: ctx.directory,
      title: "legacy",
      version: "test",
      cost: 1,
    })
    .run()
    .pipe(Effect.orDie)
  for (const [index, message] of legacy(ctx.directory).entries()) {
    const { id: messageID, ...data } = message.info
    yield* db
      .insert(MessageTable)
      .values({ id: messageID as never, session_id: sessionID, time_created: data.time.created, data: data as never })
      .run()
      .pipe(Effect.orDie)
    for (const [partIndex, part] of message.parts.entries())
      yield* db
        .insert(PartTable)
        .values({
          id: `prt_${id}_${index}${String(partIndex).padStart(3, "0")}` as never,
          message_id: messageID as never,
          session_id: sessionID,
          time_created: data.time.created,
          data: part as never,
        })
        .run()
        .pipe(Effect.orDie)
  }
  return sessionID
})

const partTypes = (messages: ReadonlyArray<{ parts: ReadonlyArray<{ type: string }> }>) =>
  messages.map((message) => message.parts.map((part) => part.type))

describe("session archive", () => {
  it.instance("keeps every legacy part through backfill and compaction", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = yield* createLegacySession("ses_archive_legacy")
      const original = legacy("/unused")

      const before = yield* archive(sessionID)
      if (!before) throw new Error("missing archive")
      expect(before.version).toBe(2)
      expect(partTypes(before.messages)).toEqual(partTypes(original))

      yield* SessionBackfill.backfill(database.db)
      const after = yield* withoutLegacyTables(
        Effect.gen(function* () {
          expect(yield* SessionLegacyTables.present(database.db)).toBe(false)
          return yield* archive(sessionID)
        }),
      )
      if (!after) throw new Error("missing archive")
      // 22 parts became 8 before step markers and patches were preserved.
      expect(partTypes(after.messages)).toEqual(partTypes(original))
      expect(after.messages).toEqual(before.messages)

      const [asked, answered, delegated, failed, compacting, summary] = after.messages
      expect(asked.info).toMatchObject({ role: "user", agent: "build", model })
      expect(answered.info).toMatchObject({ role: "assistant", parentID: "msg_legacy_1", cost: 0.5, finish: "stop" })
      const tool = answered.parts.find((part) => part.type === "tool")
      expect(tool).toMatchObject({
        callID: "call_1",
        tool: "bash",
        state: { output: "a\nb", input: { command: "ls" } },
      })
      expect(delegated.parts).toMatchObject([{ text: "delegate " }, { prompt: "look around", agent: "explore" }])
      expect(failed.info).toMatchObject({ error: { name: "APIError", data: { message: "rate limited" } } })
      expect(compacting.parts).toMatchObject([{ type: "compaction", auto: false }])
      expect(summary.info).toMatchObject({ summary: true, agent: "compaction" })
      const ids = after.messages.flatMap((message) => message.parts.map((part) => part.id))
      expect(new Set(ids).size).toBe(ids.length)

      // The projection keeps the compaction as the boundary V2 history starts from.
      expect(after.projection?.map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "compaction",
      ])
    }),
  )

  it.instance(
    "round trips an archive through import without the legacy tables",
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const ctx = yield* InstanceRef
        if (!ctx) throw new Error("no instance")
        const sessionID = yield* createLegacySession("ses_archive_roundtrip")
        yield* SessionBackfill.backfill(database.db)
        const exported = yield* archive(sessionID)
        if (!exported) throw new Error("missing archive")

        yield* database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        const reimported = yield* withoutLegacyTables(
          Effect.gen(function* () {
            const imported = yield* importArchive(JSON.parse(JSON.stringify(exported)), ctx)
            expect(imported).toBe(sessionID)
            return yield* archive(sessionID)
          }),
        )
        if (!reimported) throw new Error("missing archive")
        expect(reimported.projection).toEqual(exported.projection)
        expect(reimported.messages).toEqual(exported.messages)
        expect(reimported.info).toMatchObject({ id: sessionID, title: "legacy", cost: 1 })
      }),
    { git: true },
  )

  it.instance("imports a V1 archive into the projection only", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const ctx = yield* InstanceRef
      if (!ctx) throw new Error("no instance")
      const sessionID = SessionSchema.ID.make("ses_archive_v1")
      const v1 = {
        info: {
          id: sessionID,
          slug: "v1",
          projectID: "elsewhere",
          directory: "/elsewhere",
          title: "from v1",
          version: "0.0.1",
          time: { created: 1, updated: 2 },
        },
        messages: legacy("/elsewhere").map((message, index) => ({
          info: { ...message.info, sessionID },
          parts: message.parts.map((part, partIndex) => ({
            ...part,
            id: `prt_v1_${index}${partIndex}`,
            sessionID,
            messageID: message.info.id,
          })),
        })),
      }
      yield* importArchive(v1, ctx)

      expect(yield* store.historyState(sessionID)).toBe("projected")
      const legacyRows = yield* database.db
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(legacyRows).toEqual([])
      const projected = yield* database.db
        .select({ seq: SessionMessageTable.seq, type: SessionMessageTable.type })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(SessionMessageTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(projected.map((row) => row.type)).toEqual(["user", "assistant", "user", "assistant", "user", "compaction"])
      expect(projected.every((row) => row.seq < 0)).toBe(true)
      // V2 history starts at the compaction instead of resending what it summarized.
      expect((yield* store.context(sessionID)).map((message) => message.type)).toEqual(["compaction"])

      const exported = yield* archive(sessionID)
      expect(partTypes(exported?.messages ?? [])).toEqual(partTypes(v1.messages))
      expect(exported?.info).toMatchObject({ projectID: ctx.project.id, directory: ctx.directory })
    }),
  )

  it.instance("refuses an archive newer than it understands", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceRef
      if (!ctx) throw new Error("no instance")
      const exit = yield* importArchive({ version: 99, info: {}, messages: [] }, ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
