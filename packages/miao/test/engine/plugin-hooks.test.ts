import { describe, expect } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionStore } from "@miao/core/session/store"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { Effect, Layer, Scope } from "effect"
import { PluginHooks } from "../../src/engine/plugin-hooks"
import { testEffect } from "../lib/effect"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(ToolPlugins.node, [[ToolOutputStore.node, outputStore]]),
)

const configuration = { binary: "miao-engine", model: "test-model" } as const

const store = {
  get: () => Effect.succeed({ agent: AgentV2.ID.make("build") }),
} as unknown as SessionStore.Interface

const call = (kind: "before" | "after", extra: Record<string, unknown> = {}) => ({
  sessionID: "ses_plugin_hooks",
  kind,
  tool: "echo",
  callID: "call-hooks-1",
  ...extra,
})

describe("PluginHooks", () => {
  it.effect("marks registered families and answers a before transform", () =>
    Effect.gen(function* () {
      const plugins = yield* ToolPlugins.Service
      const scope = yield* Scope.make()
      yield* plugins.hook
        .before((event) => {
          event.args = { text: "rewritten" }
        })
        .pipe(Scope.provide(scope))
      const options = yield* PluginHooks.prepare(configuration, { store })
      expect(options.pluginHooksFile).toBeString()
      const marker = yield* Effect.promise(() => Bun.file(options.pluginHooksFile!).json())
      expect(marker).toEqual({ before: true, after: false, definition: false })
      const verdict = yield* Effect.promise(() =>
        options.onHookTool!(call("before", { args: { text: "original" } })),
      )
      expect(verdict).toEqual({ args: { text: "rewritten" } })
    }),
  )

  it.effect("answers a definition review and passes an untouched tool through", () =>
    Effect.gen(function* () {
      const plugins = yield* ToolPlugins.Service
      const scope = yield* Scope.make()
      yield* plugins.hook
        .definition((event) => {
          event.description = "reviewed by the plugin"
        })
        .pipe(Scope.provide(scope))
      const options = yield* PluginHooks.prepare(configuration, { store })
      const verdict = yield* Effect.promise(() =>
        options.onHookTool!(
          call("definition", {
            definition: { name: "read_file", description: "original", input_schema: {} },
          }),
        ),
      )
      expect(verdict).toEqual({
        definition: { name: "echo", description: "reviewed by the plugin", input_schema: {} },
      })
    }),
  )

  it.effect("answers an after transform and passes an untouched result through", () =>
    Effect.gen(function* () {
      const plugins = yield* ToolPlugins.Service
      const scope = yield* Scope.make()
      yield* plugins.hook
        .after((event) => {
          event.output = `${event.output}+after`
        })
        .pipe(Scope.provide(scope))
      const options = yield* PluginHooks.prepare(configuration, { store })
      const replaced = yield* Effect.promise(() =>
        options.onHookTool!(call("after", { args: { text: "x" }, output: { text: "raw" } })),
      )
      expect(replaced).toEqual({ output: `{"text":"raw"}+after` })
      const untouched = yield* Effect.promise(() =>
        options.onHookTool!(call("before", { args: { text: "same" } })),
      )
      expect(untouched).toEqual({ args: { text: "same" } })
    }),
  )

  it.effect("maps a failing hook to a deny verdict", () =>
    Effect.gen(function* () {
      const plugins = yield* ToolPlugins.Service
      const scope = yield* Scope.make()
      yield* plugins.hook
        .before(() => Effect.fail("audit said no"))
        .pipe(Scope.provide(scope))
      const options = yield* PluginHooks.prepare(configuration, { store })
      const verdict = yield* Effect.promise(() =>
        options.onHookTool!(call("before", { args: { text: "x" } })),
      )
      expect(verdict).toEqual({
        deny: "tool.execute.before hook rejected the call: audit said no",
      })
    }),
  )

  it.effect("prepares nothing when no plugin registered a hook", () =>
    Effect.gen(function* () {
      const options = yield* PluginHooks.prepare(configuration, { store })
      expect(options.pluginHooksFile).toBeUndefined()
      expect(options.onHookTool).toBeUndefined()
    }),
  )
})
