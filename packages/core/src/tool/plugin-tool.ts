export * as PluginTool from "./plugin-tool"

import { ToolFailure } from "@miao/llm"
import type { ToolContext, ToolDefinition, ToolResult } from "@miao/plugin/tool"
import { Effect, type JsonSchema } from "effect"
import z from "zod"
import type { PermissionV2 } from "../permission"
import { Tool } from "./tool"

export type Definition = ToolDefinition

export interface Services {
  readonly permission: PermissionV2.Interface
  readonly directory: string
  readonly worktree: string
}

/** Whether a module export is a `tool({ description, args, execute })` definition. */
export function is(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

/**
 * Adapts a `@miao/plugin` tool definition (custom `{tool,tools}/*.ts`
 * files and plugin-provided tools) into a canonical Core tool.
 *
 * Like built-ins, every call first asserts a PermissionV2 decision under the
 * registered tool name, so agent rules such as `"github-triage": "deny"` or
 * `ask` apply. The definition's own `context.ask(...)` maps to the same
 * PermissionV2 assertion with its requested action and patterns.
 */
export function make(name: string, definition: ToolDefinition, services: Services): Tool.AnyTool {
  // Missing args mean no parameters; Zod tolerated `undefined` before 1.14.49.
  const args = definition.args ?? {}
  const entries = Object.entries(args)
  const parser = entries.every((entry) => isZodType(entry[1])) ? z.object(args) : undefined
  return Tool.makeExternal({
    description: definition.description,
    inputSchema: (parser ? zodJsonSchema(parser) : legacyJsonSchema(entries)) as JsonSchema.JsonSchema,
    execute: (input, context) => {
      const source = { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID }
      const assert = (request: {
        action: string
        resources: string[]
        save: string[]
        metadata: Record<string, unknown>
      }) =>
        services.permission
          .assert({ ...request, sessionID: context.sessionID, agent: context.agent, source })
          .pipe(Effect.catchTags(permissionFailures(name)))
      return Effect.gen(function* () {
        yield* assert({ action: name, resources: ["*"], save: ["*"], metadata: { tool: name, input } })
        const parsed = parser?.safeParse(input)
        if (parsed && !parsed.success)
          return yield* new ToolFailure({ message: `Invalid tool input: ${parsed.error.message}` })
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            definition.execute((parsed ? parsed.data : input) as never, {
              sessionID: context.sessionID,
              messageID: context.assistantMessageID,
              agent: context.agent,
              directory: services.directory,
              worktree: services.worktree,
              abort: signal,
              metadata: (update) => {
                if (!context.progress) return
                Effect.runFork(context.progress({ structured: { title: update.title, ...update.metadata } }))
              },
              ask: (request) =>
                Effect.runPromise(
                  assert({
                    action: request.permission,
                    resources: request.patterns,
                    save: request.always,
                    metadata: request.metadata,
                  }),
                ),
            } satisfies ToolContext),
          catch: (error) =>
            error instanceof ToolFailure
              ? error
              : new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        })
        return content(result)
      })
    },
  })
}

function permissionFailures(name: string) {
  return {
    "PermissionV2.BlockedError": (error: PermissionV2.BlockedError) =>
      Effect.fail(
        new ToolFailure({
          message: `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(error.rules)}`,
        }),
      ),
    "PermissionV2.CorrectedError": (error: PermissionV2.CorrectedError) =>
      Effect.fail(
        new ToolFailure({
          message: `The user rejected permission to use this specific tool call with the following feedback: ${error.feedback}`,
        }),
      ),
    "Session.NotFoundError": () => Effect.fail(new ToolFailure({ message: `Tool ${name} failed: session not found` })),
  }
}

function content(result: ToolResult): ReadonlyArray<Tool.Content> {
  if (typeof result === "string") return [{ type: "text", text: result }]
  return [
    { type: "text", text: result.output },
    ...(result.attachments ?? []).flatMap((attachment): Tool.Content[] => {
      // Only inline data URLs can travel as model-facing file content.
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(attachment.url)
      if (!match) return [{ type: "text", text: `[attachment: ${attachment.filename ?? attachment.url}]` }]
      const data = match[2] ? match[3]! : Buffer.from(decodeURIComponent(match[3]!)).toString("base64")
      return [{ type: "file", data, mime: attachment.mime, name: attachment.filename }]
    }),
  ]
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function legacyJsonSchema(entries: [string, unknown][]) {
  const properties = Object.fromEntries(
    entries.filter((entry) => typeof entry[1] === "boolean" || (typeof entry[1] === "object" && entry[1] !== null)),
  )
  return { type: "object", properties, required: Object.keys(properties) }
}

function zodJsonSchema(schema: z.ZodType) {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isRecord(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return $defs && isRecord($defs) ? { ...rest, definitions: $defs } : rest
}

// Descriptions attached through another Zod instance's registry (the plugin's own
// `zod` copy) are invisible to ours, so collect them explicitly.
function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }
    Object.values(value).forEach(collect)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeZodJsonSchema)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry) =>
          !((entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"),
      )
      .map((entry) => [entry[0], normalizeZodJsonSchema(entry[1])]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
