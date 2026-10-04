export * as SessionTodo from "./todo"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionTodo } from "@miao/schema/session-todo"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { TodoTable } from "./sql"
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
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionTodo") {}

/** Session-owned task state, refreshed at provider-turn boundaries and after compaction. */
export function context(todos: Interface, sessionID: SessionSchema.ID) {
  return SystemContext.make({
    key: SystemContext.Key.make("session/todos"),
    codec: Schema.toCodecJson(Schema.Array(Info)),
    load: todos.get(sessionID),
    baseline: renderContext,
    update: (_previous, current) => renderContext(current),
  })
}

function renderContext(todos: ReadonlyArray<Info>) {
  return [
    "# Current session task list",
    "This is the current persisted todo list, also displayed to the user. It supersedes older todo lists in the conversation.",
    "Use todowrite to track multi-step work. Keep this list synchronized with actual progress: mark work in_progress when starting, completed immediately after finishing and verifying it, and cancelled when it is no longer required. Update it before a final response or handoff; do not leave finished work pending or mark unfinished work completed. If blocked, leave the task open and explain the blocker. Do not infer completion merely from an idle session or a successful tool call.",
    JSON.stringify(todos, null, 2),
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly todos: ReadonlyArray<Info>
    }) {
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

    return Service.of({ update, get })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
