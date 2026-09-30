export * as ListSessionsTool from "./list-sessions"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool } from "./tool"

export const name = "list_sessions"

export type Summary = {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly parentID?: string
}

/** Session capability injected by the runner so the tool can enumerate sibling Sessions. */
export type List = () => Effect.Effect<ReadonlyArray<Summary>, ToolFailure>

export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      title: Schema.String,
      parentID: Schema.String.pipe(Schema.optional),
    }),
  ),
})

const DESCRIPTION = [
  "List the other Sessions in the same project so you can address them with send_message.",
  "Each entry has an id, a slug, and a title; use `@slug` (or the id) as send_message's target.",
].join(" ")

/** Builds the canonical list_sessions tool around a runner-provided enumeration capability. */
export const make = (list: List): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) =>
      output.sessions.length === 0
        ? [{ type: "text", text: "No other sessions in this project." }]
        : [
            {
              type: "text",
              text: output.sessions
                .map((session) => `${session.id} (@${session.slug}) — ${session.title}`)
                .join("\n"),
            },
          ],
    execute: () => list().pipe(Effect.map((sessions) => ({ sessions }))),
  })
