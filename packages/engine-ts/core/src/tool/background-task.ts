export * as BackgroundTaskTool from "./background-task"

import { Effect, Schema } from "effect"
import { ToolFailure } from "@miao/llm"
import type { SessionDelegationStore } from "../session/delegation-store"
import { Tool, type AnyTool } from "./tool"

const Info = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "interrupted", "cancelled"]),
})
const render = (task: SessionDelegationStore.Info) => ({
  id: task.id,
  sessionID: task.child_session_id,
  description: task.description,
  status: task.status,
})

export const make = (api: {
  list: () => Effect.Effect<ReadonlyArray<SessionDelegationStore.Info>>
  result: (id: string) => Effect.Effect<SessionDelegationStore.Info | undefined>
  cancel: (id: string, context: Tool.Context) => Effect.Effect<boolean, ToolFailure>
}): Record<string, AnyTool> => ({
  task_list: Tool.withConcurrency(
    Tool.make({
      description: "List this Session's recent background subagent tasks, with child Session IDs and durable status.",
      input: Schema.Struct({}),
      output: Schema.Struct({ tasks: Schema.Array(Info) }),
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.tasks) }],
      execute: () => api.list().pipe(Effect.map((tasks) => ({ tasks: tasks.map(render) }))),
    }),
    "concurrent",
  ),
  task_result: Tool.withConcurrency(
    Tool.make({
      description:
        "Read a background task's durable report by the taskID returned from task. Does not wait or restart it.",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ task: Info, text: Schema.String }),
      toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
      execute: ({ id }) =>
        Effect.gen(function* () {
          const task = yield* api.result(id)
          if (!task) return yield* new ToolFailure({ message: "Unknown background task for this Session." })
          return { task: render(task), text: task.result ?? "Background task is still running." }
        }),
    }),
    "concurrent",
  ),
  task_cancel: Tool.make({
    description:
      "Cancel an owned background subagent task. Interrupting the parent alone does not cancel background children.",
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ cancelled: Schema.Boolean }),
    toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
    execute: ({ id }, context) => api.cancel(id, context).pipe(Effect.map((cancelled) => ({ cancelled }))),
  }),
})
