export * as ListSessionsTool from "./list-sessions"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool } from "./tool"

export const name = "list_sessions"

export const Summary = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  parentID: Schema.optional(Schema.String),
  execution: Schema.Literals(["busy", "idle", "unknown"]),
  task: Schema.Literals(["unfinished", "completed", "unknown"]),
  lastActivity: Schema.Number,
  backgroundJobs: Schema.Number,
  objective: Schema.optional(Schema.String),
})
export type Summary = typeof Summary.Type

export const Input = Schema.Struct({
  includeHistory: Schema.optional(Schema.Boolean).annotate({
    description:
      "Include idle historical Sessions. Default lists Sessions with active execution or unfinished work only.",
  }),
})
export type List = (input: typeof Input.Type) => Effect.Effect<ReadonlyArray<Summary>, ToolFailure>
export const Output = Schema.Struct({ sessions: Schema.Array(Summary) })

const DESCRIPTION = [
  "Discover other Sessions in the same project, prioritizing active execution and unfinished work, not open tabs.",
  "Use includeHistory: true to find historical work; read_session_context is preferred for past findings.",
  "Execution status is process-local: unknown means another window's live state is unavailable, not idle.",
  "Unfinished goals/todos may be stale and are not proof that a resource is currently in use.",
  "A related title alone is not a reason to wake an idle Session. Coordinate near an actual conflicting operation, naming the resource, action, timing, and question.",
  "Address peers by @slug or Session ID.",
].join(" ")

export const make = (list: List): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text:
          output.sessions.length === 0
            ? "No matching Sessions. Use includeHistory: true for historical findings; read them before contacting idle peers."
            : output.sessions
                .map(
                  (session) =>
                    `${session.id} (@${session.slug}) — ${session.title} [execution: ${session.execution}; task: ${session.task}; background jobs: ${session.backgroundJobs}; last activity: ${new Date(session.lastActivity).toISOString()}]${session.objective ? `\n  ${session.objective}` : ""}`,
                )
                .join("\n"),
      },
    ],
    execute: (input) => list(input).pipe(Effect.map((sessions) => ({ sessions }))),
  })
