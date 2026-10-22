export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@miao/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { normalize } from "@miao/schema/session-todo"
import { SessionTodo } from "../session/todo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const service = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withConcurrency(
          Tool.make({
            description:
              "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current. Use stable id and depends_on for prerequisites; never assume list order means dependency. External waits block only dependent tasks. Preserve prerequisite records while other tasks reference them.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                // Normalise before validating and returning: the stored tool
                // input feeds every transcript renderer, and a stray carriage
                // return there rewinds the cursor and shreds the layout.
                const todos = normalize(input.todos)
                const invalid = SessionTodo.validate(todos)
                if (invalid !== undefined) return yield* new ToolFailure({ message: invalid })
                yield* permission.assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                yield* service.update({ sessionID: context.sessionID, todos })
                return { todos }
              }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update todos" }))),
          }),
          "concurrent",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/todowrite",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionTodo.node],
})
