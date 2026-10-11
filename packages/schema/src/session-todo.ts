export * as SessionTodo from "./session-todo"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const Info = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({
    description: "Stable task identity, required when a task declares dependencies. Keep it unchanged across updates.",
  }),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Task IDs that must be completed before this task is runnable. Omitted means no declared dependencies.",
  }),
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, waiting, blocked, completed, cancelled",
  }),
  priority: Schema.String.annotate({
    description: "Priority level of the task: high, medium, low",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/** A cancelled prerequisite is not complete. Shared by scheduling and UI projection. */
export function runnable<T extends Pick<Info, "id" | "status" | "depends_on">>(todos: ReadonlyArray<T>) {
  const byID = new Map(todos.flatMap((todo) => (todo.id === undefined ? [] : [[todo.id, todo] as const])))
  return todos.filter(
    (todo) =>
      (todo.status === "pending" || todo.status === "in_progress") &&
      (todo.depends_on ?? []).every((id) => byID.get(id)?.status === "completed"),
  )
}

const Updated = define({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }

// Compatibility name for the todo view model.
export type Todo = Info
