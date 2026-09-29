export * as TaskTool from "./task"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool } from "./tool"

export const name = "task"

/** Session capability injected by the runner so a Location leaf can spawn a subagent. */
export type Spawn = (input: {
  readonly agent: string
  readonly prompt: string
  readonly description: string
  readonly taskId?: string
}) => Effect.Effect<{ readonly sessionID: string; readonly text: string }, ToolFailure>

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Resume a previous subagent session by passing the session id it returned",
  }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.String,
})

const DESCRIPTION = [
  "Launch a specialized subagent to perform one scoped task and return its final report.",
  "Use it for independent research or work that would otherwise flood the main context.",
  "Pass task_id to continue a previous subagent session instead of starting a fresh one.",
].join(" ")

/** Builds the canonical task tool around a runner-provided spawn capability. */
export const make = (spawn: Spawn): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    execute: (input) =>
      spawn({
        agent: input.subagent_type,
        prompt: input.prompt,
        description: input.description,
        taskId: input.task_id,
      }),
  })
