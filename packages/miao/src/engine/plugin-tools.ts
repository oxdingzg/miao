import { AgentV2 } from "@miao/core/agent"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionStore } from "@miao/core/session/store"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { ToolRegistry } from "@miao/core/tool/registry"
import { Tool, type AnyTool } from "@miao/core/tool/tool"
import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"

/**
 * Product-tool bridge for plugin-provided tools.
 *
 * The engine cannot see the host plugin catalog, so the manifest exposes a
 * stable list/call pair instead of one product tool per plugin. Listing uses
 * the same materialization (and therefore the same definition hooks and agent
 * permission rules) as a TypeScript Session; calling settles through the
 * registry, which runs the plugin before/after hooks.
 */
export const make = (input: {
  readonly registry: ToolRegistry.Interface
  readonly plugins: ToolPlugins.Interface
  readonly agents: AgentV2.Interface
  readonly store: SessionStore.Interface
}) => {
  const resolveAgent = Effect.fn("Engine.pluginTools.agent")(function* (sessionID: SessionSchema.ID) {
    const session = yield* input.store.get(sessionID)
    return yield* input.agents.resolve(session?.agent)
  })

  const materialize = Effect.fn("Engine.pluginTools.materialize")(function* (sessionID: SessionSchema.ID) {
    const agent = yield* resolveAgent(sessionID)
    const names = new Set(input.plugins.names())
    const materialization = yield* input.registry.materialize(agent?.permissions, { sessionID })
    return {
      agent,
      materialization,
      definitions: materialization.definitions.filter((definition) => names.has(definition.name)),
    }
  })

  const list: AnyTool = Tool.make({
    description:
      "List the plugin-provided tools available to this Session. Use plugin_tool with one of these names to call it.",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: (_, context) =>
      Effect.gen(function* () {
        const { definitions } = yield* materialize(context.sessionID)
        if (definitions.length === 0) return "No plugin tools are available."
        return JSON.stringify(
          definitions.map((definition) => ({
            name: definition.name,
            description: definition.description,
            input_schema: definition.inputSchema,
          })),
        )
      }),
  })

  const call: AnyTool = Tool.make({
    description:
      "Call a plugin-provided tool by name. List the available names with plugin_tools first. The plugin's execute.before/after hooks run around the call.",
    input: Schema.Struct({
      name: Schema.String,
      input: Schema.Unknown,
    }),
    output: Schema.String,
    execute: (request, context) =>
      Effect.gen(function* () {
        if (!input.plugins.names().includes(request.name))
          return yield* new ToolFailure({ message: `Plugin tool is not available: ${request.name}` })
        const { agent, materialization, definitions } = yield* materialize(context.sessionID)
        if (!definitions.some((definition) => definition.name === request.name))
          return yield* new ToolFailure({ message: `Plugin tool is not available: ${request.name}` })
        const settlement = yield* materialization
          .settle({
            sessionID: context.sessionID,
            agent: agent?.id ?? AgentV2.defaultID,
            assistantMessageID: context.assistantMessageID,
            call: {
              type: "tool-call",
              id: context.toolCallID,
              name: request.name,
              input: request.input,
            },
          })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) })))
        const value = settlement.result.value
        return typeof value === "string" ? value : JSON.stringify(value)
      }),
  })

  return { plugin_tools: list, plugin_tool: call }
}

export * as PluginTools from "./plugin-tools"
