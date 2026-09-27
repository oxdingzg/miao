export * as ToolCodeMode from "./code-mode"

import { type ToolCall, type ToolDefinition } from "@miao/llm"
import { CodeMode, Tool as SandboxTool, toolError } from "@miao/codemode"
import { Effect, Schema } from "effect"
import type { ToolOutputStore } from "../tool-output-store"
import { Tool, type AnyTool, type Context } from "./tool"
import type { Settlement } from "./registry"

export const CODE_MODE_TOOL = "execute"

const toolNamespace = "miao"

const Parameters = Schema.Struct({
  code: Schema.String.annotate({ description: "Script body executed by the confined interpreter." }),
})

const Output = Schema.Struct({
  text: Schema.String,
  toolCalls: Schema.Array(Schema.String),
})

type Run = (definition: ToolDefinition, value: unknown) => Effect.Effect<unknown, unknown>

const buildTools = (definitions: ReadonlyArray<ToolDefinition>, run: Run) => {
  const tools: Record<string, SandboxTool.Definition> = {}
  for (const definition of definitions) {
    tools[definition.name] = SandboxTool.make({
      description: definition.description ?? "",
      input: definition.inputSchema as SandboxTool.JsonSchema,
      output: definition.outputSchema as SandboxTool.JsonSchema,
      run: (value) => run(definition, value),
    })
  }
  return { [toolNamespace]: tools }
}

const messageOf = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const withLogs = (text: string, logs: ReadonlyArray<string>) =>
  [text, ...(logs.length === 0 ? [] : ["Logs:", ...logs])].filter((line) => line.length > 0).join("\n")

/**
 * Wraps the materialized tool set behind one `execute` tool. The individual definitions
 * are replaced by the `execute` signature plus a budgeted Code Mode catalog in its
 * description, so tool-schema tokens shrink to the frontier the model actually needs.
 */
export const make = (input: {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<Settlement, ToolOutputStore.Error>
}): AnyTool => {
  const preview = CodeMode.make({
    tools: buildTools(input.definitions, () => Effect.fail(toolError("Tool preview is not executable."))),
  })

  return Tool.make({
    description: [
      "Run a confined orchestration script that can call the available tools.",
      preview.instructions(),
    ].join("\n\n"),
    input: Parameters,
    output: Output,
    execute: Effect.fn("ToolCodeMode.execute")(function* (parameters, context) {
      let calls = 0
      const runtime = CodeMode.make({
        tools: buildTools(input.definitions, (definition, value) =>
          Effect.gen(function* () {
            calls += 1
            const settlement = yield* input.settle(
              { type: "tool-call", id: `${context.toolCallID}/${calls}`, name: definition.name, input: value ?? {} },
              context,
            )
            if (settlement.result.type === "error")
              return yield* Effect.fail(toolError(messageOf(settlement.result.value)))
            return settlement.output?.structured ?? settlement.result.value
          }),
        ),
      })
      const result = yield* runtime.execute(parameters.code)
      const logs = result.logs ?? []
      const toolCalls = result.toolCalls.map((call) => call.name)
      if (!result.ok) {
        const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
        return { text: withLogs([result.error.message, ...hints].join("\n"), logs), toolCalls }
      }
      const text =
        typeof result.value === "string"
          ? result.value
          : (JSON.stringify(result.value, null, 2) ?? String(result.value))
      return { text: withLogs(text, logs), toolCalls }
    }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })
}
