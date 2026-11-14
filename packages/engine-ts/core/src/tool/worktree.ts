export * as WorktreeTool from "./worktree"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool } from "./tool"

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }]

export const EnterInput = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description: "A short name for the worktree. A unique one is generated when omitted.",
  }),
  copyChanges: Schema.optional(Schema.Boolean).annotate({
    description: "Carry this checkout's uncommitted changes into the worktree. Off by default.",
  }),
})

export const EnterOutput = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  branch: Schema.String.pipe(Schema.optional),
})

export const ExitInput = Schema.Struct({
  action: Schema.Literals(["keep", "remove"]).annotate({
    description: "keep leaves the worktree on disk; remove deletes it together with its branch.",
  }),
})

export const ExitOutput = Schema.Struct({
  directory: Schema.String,
  removed: Schema.Boolean,
})

const ENTER_DESCRIPTION = [
  "Create a git worktree and move this Session into it.",
  "Use it to work on a change without touching the checkout the Session started in.",
  "The worktree is a separate directory on its own branch, and every following tool call in this",
  "Session runs there. The Session keeps its history; only its working directory changes.",
  "Leave with exit_worktree when the work is done.",
].join(" ")

const EXIT_DESCRIPTION = [
  "Return this Session to the checkout it entered the worktree from.",
  "Pass action keep to leave the worktree on disk for later, or remove to delete it and its branch.",
  "Removing discards uncommitted changes in the worktree, so commit first when they matter.",
].join(" ")

/** The worktree a Session is currently in, as the runner resolved it. */
export type EnterResult = Schema.Schema.Type<typeof EnterOutput>
export type ExitResult = Schema.Schema.Type<typeof ExitOutput>

/**
 * Worktree enter/exit, injected by the runner.
 *
 * Placement is Session state: entering publishes a durable `session.next.moved`
 * event that every client and the next drain read, so the capability lives
 * where the Session store and the git services already are rather than in a
 * Location-scoped leaf that would have to reach outside its own graph.
 */
export const make = (api: {
  readonly enter: (
    input: { readonly name?: string; readonly copyChanges?: boolean },
    context: Tool.Context,
  ) => Effect.Effect<EnterResult, ToolFailure>
  readonly exit: (
    input: { readonly action: "keep" | "remove" },
    context: Tool.Context,
  ) => Effect.Effect<ExitResult, ToolFailure>
}): Record<string, AnyTool> => ({
  enter_worktree: Tool.make({
    description: ENTER_DESCRIPTION,
    input: EnterInput,
    output: EnterOutput,
    toModelOutput: ({ output }) => text(output),
    execute: (input, context) => api.enter(input, context),
  }),
  exit_worktree: Tool.make({
    description: EXIT_DESCRIPTION,
    input: ExitInput,
    output: ExitOutput,
    toModelOutput: ({ output }) => text(output),
    execute: (input, context) => api.exit(input, context),
  }),
})
