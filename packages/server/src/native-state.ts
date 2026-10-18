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

/** An input the engine admitted but has not promoted into a visible turn yet. */
const Pending = Schema.Struct({ pending: Schema.Array(Schema.Unknown) })

/**
 * Whether the engine would treat this Session as idle. A run that already
 * settled is not enough on its own: a just-admitted input is still pending
 * until the engine promotes it, so returning on the absent run alone would
 * report idle during the admission-to-run window.
 */
export function nativeIdle(snapshot: unknown): boolean {
  if (nativeExecution(snapshot).type !== "idle") return false
  return Schema.decodeUnknownSync(Pending)(snapshot).pending.length === 0
}

/** Read the ledger's todo projection, including dependency and waiting state. */
export function nativeTodos(snapshot: unknown): readonly SessionTodo.Info[] {
  return Schema.decodeUnknownSync(Todos)(snapshot).state.todos?.value.todos ?? []
}
