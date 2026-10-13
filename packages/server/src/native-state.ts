import { Schema } from "effect"
import { SessionExecution } from "@miao/schema/session-execution"
import { SessionTodo } from "@miao/schema/session-todo"

const Execution = Schema.Struct({ active_run: Schema.NullOr(SessionExecution.ID) })
const Todos = Schema.Struct({
  state: Schema.Struct({
    todos: Schema.NullOr(Schema.Struct({ value: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }) })),
  }),
})

/** The engine's active run is already a UUID, the public execution ID format. */
export function nativeExecution(snapshot: unknown): SessionExecution.State {
  const run = Schema.decodeUnknownSync(Execution)(snapshot).active_run
  return run === null ? { type: "idle" } : { type: "running", executionID: run }
}

/** Read the ledger's todo projection, including dependency and waiting state. */
export function nativeTodos(snapshot: unknown): readonly SessionTodo.Info[] {
  return Schema.decodeUnknownSync(Todos)(snapshot).state.todos?.value.todos ?? []
}
