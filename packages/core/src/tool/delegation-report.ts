export * as DelegationReportTool from "./delegation-report"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool, type Context } from "./tool"

export const name = "report"

/** Longest progress note a subagent may forward to its parent. */
export const MAX_REPORT_BYTES = 8 * 1024
/**
 * Progress notes one delegation may send. The runner enforces it against
 * `SessionDelegationStore.progressCount`, so the budget is per task, not per
 * drain: a restarted child cannot start the count over.
 */
export const MAX_REPORTS = 8

/** Session capability injected by the runner while this Session is a running background subagent. */
export type Report = (
  input: { readonly text: string },
  context: Context,
) => Effect.Effect<
  { readonly queued: boolean; readonly parentUnread: number; readonly reportsRemaining: number },
  ToolFailure
>

export const Input = Schema.Struct({
  text: Schema.String.annotate({
    description: "What the parent needs to know now. Keep it to a few sentences.",
  }),
})

export const Output = Schema.Struct({
  /** Always true today: a report is queued for the parent's next safe boundary. */
  queued: Schema.Boolean,
  parentUnread: Schema.Number,
  reportsRemaining: Schema.Number,
})

const DESCRIPTION = [
  "Send the parent Session an interim note while your background task is still running.",
  "Use it when the parent would act differently knowing this now — a blocker you hit, a decision you made that changes the plan, a partial result it can start on. The parent reads it at its next safe provider-turn boundary; it does not interrupt what the parent is doing.",
  "This does not end your task: it is a note, not a result. Finish by replying as usual, which is what settles the delegation and returns your full report.",
  "Do not narrate routine progress, restate your prompt, or send an acknowledgment. Each report costs the parent a turn, and there is a small limit per task.",
].join(" ")

/** Builds the canonical report tool around a runner-provided reporting capability. */
export const make = (report: Report): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text: [
          `Report delivered to the parent Session (${output.parentUnread} unread there).`,
          output.reportsRemaining > 0
            ? `${output.reportsRemaining} progress reports remain for this task.`
            : "That was the last progress report for this task; finish it to deliver your result.",
        ].join(" "),
      },
    ],
    execute: (input, context) => report({ text: input.text }, context),
  })
