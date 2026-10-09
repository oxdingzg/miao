import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { EventV2 } from "@miao/core/event"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { SessionMessageTable, SessionTable, TodoTable } from "@miao/core/session/sql"
import { SystemContext } from "@miao/core/system-context"
import { SessionTodo } from "@miao/core/session/todo"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionTodo.node])))
const sessionID = SessionV2.ID.make("ses_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
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
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  const insertAssistantTurns = (input: { readonly startSeq: number; readonly count: number; readonly from: number }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionMessageTable)
        .values(
          Array.from({ length: input.count }, (_, index) => ({
            id: SessionMessage.ID.make(`msg_stale_${input.startSeq + index}`),
            session_id: sessionID,
            type: "assistant" as const,
            seq: input.startSeq + index,
            time_created: input.from + index,
            data: { type: "assistant", time: { created: input.from + index } } as never,
          })),
        )
        .run()
        .pipe(Effect.orDie)
    })

  it.effect("re-injects a reconciliation nudge once the list goes stale across provider turns", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const source = SessionTodo.context(todos, sessionID)
      yield* todos.update({
        sessionID,
        todos: [{ content: "verify release", status: "in_progress", priority: "high" }],
      })
      const fresh = yield* SystemContext.initialize(source)
      expect(fresh.baseline).not.toContain("provider turns while work continued")
      expect(yield* SystemContext.reconcile(source, fresh.snapshot)).toEqual({ _tag: "Unchanged" })

      yield* insertAssistantTurns({ startSeq: 1, count: 10, from: Date.now() + 1_000 })
      const stale = yield* SystemContext.reconcile(source, fresh.snapshot)
      expect(stale._tag).toBe("Updated")
      if (stale._tag !== "Updated") throw new Error("expected stale todo context update")
      expect(stale.text).toContain("has not been updated for 8 provider turns")
      expect(stale.text).toContain('"content": "verify release"')

      // The quantized count only moves every 4 further unsynced turns, so the
      // reminder does not fire on every provider-turn boundary.
      expect(yield* SystemContext.reconcile(source, stale.snapshot)).toEqual({ _tag: "Unchanged" })
      yield* insertAssistantTurns({ startSeq: 11, count: 4, from: Date.now() + 2_000 })
      const staler = yield* SystemContext.reconcile(source, stale.snapshot)
      expect(staler._tag).toBe("Updated")
      if (staler._tag !== "Updated") throw new Error("expected a re-nudged todo context")
      expect(staler.text).toContain("has not been updated for 12 provider turns")
    }),
  )

  it.effect("treats an unchanged todowrite as a sync that resets the staleness anchor", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const list = [{ content: "verify release", status: "in_progress", priority: "high" }]
      yield* todos.update({ sessionID, todos: list })
      // Age the anchor so the seeded turns count as unsynced work.
      yield* db
        .update(TodoTable)
        .set({ time_updated: 1 })
        .where(eq(TodoTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* insertAssistantTurns({ startSeq: 1, count: 10, from: 100 })
      expect((yield* todos.observe(sessionID)).turnsBehind).toBe(10)
      yield* todos.update({ sessionID, todos: list })
      expect((yield* todos.observe(sessionID)).turnsBehind).toBe(0)
    }),
  )

  it.effect("does not nudge reconciliation for a list with nothing open", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const source = SessionTodo.context(todos, sessionID)
      yield* todos.update({
        sessionID,
        todos: [{ content: "verify release", status: "completed", priority: "high" }],
      })
      const baseline = yield* SystemContext.initialize(source)
      yield* insertAssistantTurns({ startSeq: 1, count: 10, from: Date.now() + 1_000 })
      expect(yield* SystemContext.reconcile(source, baseline.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("refreshes persisted task context, survives replacement and isolates sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const source = SessionTodo.context(todos, sessionID)
      const empty = yield* SystemContext.initialize(source)
      expect(empty.baseline).toContain("Update it before a final response or handoff")
      yield* todos.update({
        sessionID,
        todos: [{ content: "verify release", status: "in_progress", priority: "high" }],
      })
      const resumed = yield* SystemContext.initialize(source)
      expect(resumed.baseline).toContain('"content": "verify release"')
      expect(resumed.baseline).toContain('"status": "in_progress"')
      expect(yield* SystemContext.reconcile(source, resumed.snapshot)).toEqual({ _tag: "Unchanged" })
      yield* todos.update({ sessionID, todos: [{ content: "verify release", status: "completed", priority: "high" }] })
      const updated = yield* SystemContext.reconcile(source, resumed.snapshot)
      expect(updated._tag).toBe("Updated")
      if (updated._tag !== "Updated") throw new Error("expected todo context update")
      expect(updated.text).toContain('"status": "completed"')
      const compacted = yield* SystemContext.replace(source, updated.snapshot)
      expect(compacted._tag).toBe("ReplacementReady")
      if (compacted._tag !== "ReplacementReady") throw new Error("expected replacement")
      expect(compacted.generation.baseline).toContain('"status": "completed"')
      const other = yield* SystemContext.initialize(SessionTodo.context(todos, SessionV2.ID.make("ses_other")))
      expect(other.baseline).not.toContain("verify release")
      yield* todos.update({ sessionID, todos: [] })
      const cleared = yield* SystemContext.reconcile(source, updated.snapshot)
      expect(cleared._tag).toBe("Updated")
      if (cleared._tag !== "Updated") throw new Error("expected cleared context")
      expect(cleared.text).not.toContain("verify release")
      expect(cleared.text).toContain("[]")
    }),
  )

  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
        })),
      ).toEqual([
        { content: "second", position: 0 },
        { content: "first", position: 1 },
      ])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low" },
            { content: "first", status: "in_progress", priority: "high" },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] },
        { sessionID, todos: [] },
      ])

      // An unchanged list rewrites nothing and publishes nothing.
      yield* todos.update({ sessionID, todos: [] })
      expect(published).toHaveLength(3)
      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(published).toHaveLength(4)
      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "completed", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(published).toHaveLength(5)
    }),
  )
})
