import { describe, expect } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionStore } from "@miao/core/session/store"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { ToolRegistry } from "@miao/core/tool/registry"
import { Tool } from "@miao/core/tool/tool"
import { Effect, Layer, Schema, Scope } from "effect"
import { PluginTools } from "../../src/engine/plugin-tools"
import { testEffect } from "../lib/effect"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolPlugins.node, ToolRegistry.node]), [[ToolOutputStore.node, outputStore]]),
)

const sessionID = SessionSchema.ID.make("ses_plugin_tools")
const calls: unknown[] = []
const echo = Tool.make({
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: (input) => Effect.sync(() => calls.push(input)).pipe(Effect.as({ text: input.text })),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})

const setup = Effect.gen(function* () {
  calls.length = 0
  const registry = yield* ToolRegistry.Service
  const plugins = yield* ToolPlugins.Service
  const agents = {
    resolve: () => Effect.succeed({ id: AgentV2.ID.make("build"), permissions: [] }),
  } as unknown as AgentV2.Interface
  const store = {
    get: () => Effect.succeed({ agent: AgentV2.ID.make("build") }),
  } as unknown as SessionStore.Interface
  const tools = PluginTools.make({ registry, plugins, agents, store })
  return { registry, plugins, tools }
})

const context = {
  sessionID,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_plugin_tools"),
  toolCallID: "call-plugin",
}

const text = (output: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  output.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")

describe("PluginTools", () => {
  it.effect("lists a provided plugin tool and runs before/after hooks around it", () =>
    Effect.gen(function* () {
      const { registry, plugins, tools } = yield* setup
      const beforeScope = yield* Scope.make()
      yield* plugins.hook
        .before((event) => {
          event.args = { text: "rewritten" }
        })
        .pipe(Scope.provide(beforeScope))
      const afterScope = yield* Scope.make()
      yield* plugins.hook
        .after((event) => {
          event.output = `${event.output}+after`
        })
        .pipe(Scope.provide(afterScope))
      const provideScope = yield* Scope.make()
      yield* plugins
        .provide({ echo: { description: "Echo", args: {}, execute: async () => "ok" } })
        .pipe(Scope.provide(provideScope))
      const registerScope = yield* Scope.make()
      yield* registry.register({ echo }).pipe(Scope.provide(registerScope))

      const listed = yield* Tool.settle(
        tools.plugin_tools,
        { type: "tool-call", id: "call-list", name: "plugin_tools", input: {} },
        context,
      )
      expect(text(listed)).toContain("echo")

      const called = yield* Tool.settle(
        tools.plugin_tool,
        { type: "tool-call", id: "call-call", name: "plugin_tool", input: { name: "echo", input: { text: "hi" } } },
        context,
      )
      expect(text(called)).toBe("rewritten+after")
      expect(calls).toEqual([{ text: "rewritten" }])
    }),
  )

  it.effect("rejects a tool that is not provided by a plugin", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup
      const error = yield* Tool.settle(
        tools.plugin_tool,
        { type: "tool-call", id: "call-missing", name: "plugin_tool", input: { name: "missing", input: {} } },
        context,
      ).pipe(Effect.flip)
      expect(error.message).toBe("Plugin tool is not available: missing")
    }),
  )
})
