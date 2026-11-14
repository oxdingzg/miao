export * as WorkflowTool from "./workflow"

import { CodeMode, Tool as SandboxTool, toolError } from "@miao/codemode"
import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool, type Context } from "./tool"

export const name = "workflow"

const Parameters = Schema.Struct({
  script: Schema.String.annotate({ description: "Workflow script executed by the confined interpreter." }),
})

const Output = Schema.Struct({
  text: Schema.String,
  sessions: Schema.Array(Schema.String),
})

const AgentInput = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform." }),
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task." }),
  agent: Schema.String.pipe(Schema.optional).annotate({
    description: 'Subagent type, for example "explore". Defaults to "general".',
  }),
})

const AgentOutput = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.String,
})

/**
 * Wall clock, fan-out, and output bounds for one workflow. Every `agent` call is a
 * whole provider turn in a child Session, so the call budget is the cost budget.
 */
export const LIMITS = { timeoutMs: 30 * 60_000, maxToolCalls: 64, maxOutputBytes: 32 * 1024 }

const DESCRIPTION = [
  "Run a confined orchestration script whose only capability is spawning subagents.",
  "Use it for a fan-out the model would otherwise orchestrate turn by turn, paying context for every report it wanted to keep.",
  "The script is plain JavaScript: loop, branch, and start independent steps together with `Promise.all`.",
  "`return` the value the caller should see, and `console.log` anything that belongs beside it.",
  "Each `agent` call is a full subagent session with its own cost. Subagents cannot spawn further subagents.",
].join(" ")

const buildTools = (
  run: (input: typeof AgentInput.Type) => Effect.Effect<typeof AgentOutput.Type, unknown>,
) => ({
  workflow: {
    agent: SandboxTool.make({
      description: "Run one subagent to completion and return its final report.",
      input: AgentInput,
      output: AgentOutput,
      run,
    }),
  },
})

/** Session capability injected by the runner: one workflow step is one subagent turn. */
export type Spawn = (
  input: { readonly prompt: string; readonly description: string; readonly agent?: string },
  context: Context,
) => Effect.Effect<{ readonly sessionID: string; readonly text: string }, ToolFailure>

/**
 * Builds the canonical workflow tool around a runner-provided subagent capability.
 * Control flow lives in the script; every turn it causes still belongs to the runner.
 */
export const make = (spawn: Spawn): AnyTool => {
  const preview = CodeMode.make({
    tools: buildTools(() => Effect.fail(toolError("Tool preview is not executable."))),
  })

  return Tool.make({
    description: [DESCRIPTION, preview.instructions()].join("\n\n"),
    input: Parameters,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    execute: Effect.fn("ToolWorkflow.execute")(function* (parameters, context) {
      const sessions: string[] = []
      const runtime = CodeMode.make({
        tools: buildTools((input) =>
          spawn(input, context).pipe(
            Effect.tap((result) => Effect.sync(() => sessions.push(result.sessionID))),
            Effect.mapError((failure) => toolError(failure.message)),
          ),
        ),
        limits: LIMITS,
      })
      const result = yield* runtime.execute(parameters.script)
      const logs = result.logs ?? []
      const withLogs = (text: string) =>
        [text, ...(logs.length === 0 ? [] : ["Logs:", ...logs])].filter((line) => line.length > 0).join("\n")
      if (!result.ok) {
        const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
        return yield* Effect.fail(
          new ToolFailure({ message: withLogs([result.error.message, ...hints].join("\n")) }),
        )
      }
      const text =
        typeof result.value === "string"
          ? result.value
          : (JSON.stringify(result.value, null, 2) ?? String(result.value))
      return { text: withLogs(text), sessions }
    }),
  })
}
