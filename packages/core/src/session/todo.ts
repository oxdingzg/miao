export * as SessionTodo from "./todo"

import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionTodo } from "@miao/schema/session-todo"
import { SessionOwnership } from "./ownership"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { SessionMessageTable, TodoTable } from "./sql"
import { SystemContext } from "../system-context"

export const Info = SessionTodo.Info
export type Info = typeof Info.Type
export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly observe: (sessionID: SessionSchema.ID) => Effect.Effect<Observation>
}

export interface Observation {
  readonly todos: ReadonlyArray<Info>
  /**
   * Provider turns worked without a todo sync: assistant messages carry one
   * row per provider turn, so this counts the rows created after the todo
   * rows were last written.
   */
  readonly turnsBehind: number
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionTodo") {}

const ContextValue = Schema.Struct({
  todos: Schema.Array(Info),
  staleTurns: Schema.Number,
})

/** Nudge once `STALE_AFTER_TURNS` provider turns pass without a todo sync, then re-nudge every `STALE_REMIND_EVERY_TURNS`. */
const STALE_AFTER_TURNS = 8
const STALE_REMIND_EVERY_TURNS = 4

function staleTurnCount(todos: ReadonlyArray<Info>, turnsBehind: number) {
  const open = todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")
  if (!open || turnsBehind < STALE_AFTER_TURNS) return 0
  return STALE_AFTER_TURNS + Math.floor((turnsBehind - STALE_AFTER_TURNS) / STALE_REMIND_EVERY_TURNS) * STALE_REMIND_EVERY_TURNS
}

/**
 * Session-owned task state, refreshed at provider-turn boundaries and after
 * compaction. While the list goes unsynced across provider turns, its quantized
 * staleness count keeps changing the encoded value, so reconcile re-injects the
 * block with a reconciliation nudge instead of leaving the stale list deduped
 * out of the model's view until the model itself writes it.
 */
export function context(todos: Interface, sessionID: SessionSchema.ID) {
  return SystemContext.make({
    key: SystemContext.Key.make("session/todos"),
    codec: Schema.toCodecJson(ContextValue),
    load: Effect.map(todos.observe(sessionID), (observed) => ({
      todos: observed.todos,
      staleTurns: staleTurnCount(observed.todos, observed.turnsBehind),
    })),
    baseline: (value) => renderContext(value.todos, value.staleTurns),
    update: (_previous, current) => renderContext(current.todos, current.staleTurns),
  })
}

function renderContext(todos: ReadonlyArray<Info>, staleTurns: number) {
  const lines = [
    "# Current session task list",
    "This is the current persisted todo list, also displayed to the user. It supersedes older todo lists in the conversation.",
    "Use todowrite to track multi-step work. Keep this list synchronized with actual progress: mark work in_progress when starting, completed immediately after finishing and verifying it, and cancelled when it is no longer required. Update it before a final response or handoff; do not leave finished work pending or mark unfinished work completed. If blocked, leave the task open and explain the blocker. Do not infer completion merely from an idle session or a successful tool call.",
    JSON.stringify(todos, null, 2),
  ]
  if (staleTurns > 0) {
    lines.push(
      `This list has not been updated for ${staleTurns} provider turns while work continued. Reconcile it with todowrite before continuing: mark finished units completed, mark the unit you are working on in_progress, add newly discovered units, or rewrite the list unchanged to confirm it is still accurate.`,
    )
  }
  return lines.join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const ownership = yield* SessionOwnership.Service

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly todos: ReadonlyArray<Info>
    }) {
      yield* ownership.claim(input.sessionID)
      const current = yield* get(input.sessionID)
      if (sameTodos(current, input.todos)) {
        // An unchanged list is still a sync: refresh the staleness anchor so a
        // confirmed-accurate list quiets the reconciliation nudge without a
        // full rewrite or a duplicate event.
        yield* db
          .update(TodoTable)
          .set({ time_updated: Date.now() })
          .where(eq(TodoTable.session_id, input.sessionID))
          .run()
          .pipe(Effect.orDie)
        return
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("SessionTodo.get")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    const observe = Effect.fn("SessionTodo.observe")(function* (sessionID: SessionSchema.ID) {
      const todos = yield* get(sessionID)
      const anchor = yield* db
        .select({ synced: sql<number>`max(${TodoTable.time_updated})` })
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!anchor?.synced) return { todos, turnsBehind: 0 }
      const counted = yield* db
        .select({ turns: sql<number>`count(*)` })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "assistant"),
            gt(SessionMessageTable.time_created, anchor.synced),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return { todos, turnsBehind: counted?.turns ?? 0 }
    })

    return Service.of({ update, get, observe })
  }),
)

/**
 * A todowrite that changes nothing still paid a delete+reinsert transaction
 * and a durable event on every call; rewriting identical rows buys nothing,
 * so an unchanged list short-circuits before either.
 */
function sameTodos(current: ReadonlyArray<Info>, next: ReadonlyArray<Info>) {
  return (
    current.length === next.length &&
    current.every((todo, index) => {
      const other = next[index]!
      return todo.content === other.content && todo.status === other.status && todo.priority === other.priority
    })
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Database.node, SessionOwnership.node],
})
