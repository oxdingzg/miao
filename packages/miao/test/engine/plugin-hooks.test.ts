import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionStore } from "@miao/core/session/store"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { Deferred, Effect, Layer, Scope } from "effect"
import { PluginHooks } from "../../src/engine/plugin-hooks"
import { testEffect } from "../lib/effect"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { EngineClient } from "../../src/engine/client"
import { tmpdir } from "../fixture/fixture"

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

const call = (kind: "before" | "after" | "definition", extra: Record<string, unknown> = {}) => ({
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
      // The marker travels inline, so nothing is written to a temporary file.
      expect(options.pluginHooksFile).toBeUndefined()
      const marker = JSON.parse(options.env?.MIAO_ENGINE_PLUGIN_HOOKS ?? "null")
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
      expect(options.env).toBeUndefined()
      expect(options.onHookTool).toBeUndefined()
    }),
  )
})

for (const kind of ["before", "after", "definition"] as const)
  it.effect(`interrupts the actual ${kind} hook Effect when its callback signal aborts`, () =>
    Effect.gen(function* () {
      const plugins = yield* ToolPlugins.Service
      const scope = yield* Scope.make()
      const release = yield* Deferred.make<void>()
      const started = Promise.withResolvers<void>()
      const finalized = Promise.withResolvers<void>()
      yield* plugins.hook[kind](() =>
        Effect.sync(() => started.resolve()).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.ensuring(Effect.sync(() => finalized.resolve())),
        ),
      ).pipe(Scope.provide(scope))
      const options = yield* PluginHooks.prepare(configuration, { store })
      const controller = new AbortController()
      const pending = options.onHookTool!({ ...call(kind), signal: controller.signal }).catch(() => undefined)
      yield* Effect.promise(() => started.promise)
      controller.abort()
      const interrupted = yield* Effect.promise(() =>
        Promise.race([finalized.promise.then(() => true), Bun.sleep(500).then(() => false)]),
      )
      // Release old implementations too, so a failed regression leaves no live Effect.
      yield* Deferred.succeed(release, undefined)
      yield* Effect.promise(() => pending)
      expect(interrupted).toBe(true)
    }),
  )

for (const kind of ["before", "after", "definition"] as const) {
  const binary = process.env.MIAO_ENGINE_BIN
  if (!binary) {
    test.skip(`native cancellation releases the actual ${kind} plugin callback`, () => {})
    continue
  }
  it.effect(
    `native cancellation releases the actual ${kind} plugin callback`,
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const workspace = path.join(tmp.path, "workspace")
        yield* Effect.promise(() => mkdir(workspace))
        yield* Effect.promise(() => Bun.write(path.join(workspace, "a.txt"), "fixture"))
        const policyFile = path.join(tmp.path, "policy.json")
        yield* Effect.promise(() =>
          Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] })),
        )
        const productToolsFile = path.join(tmp.path, "product-tools.json")
        yield* Effect.promise(() => Bun.write(productToolsFile, JSON.stringify({ tools: [] })))
        const provider = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () =>
            new Response(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => provider.stop(true)))
        const plugins = yield* ToolPlugins.Service
        const scope = yield* Scope.make()
        const release = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const started = Promise.withResolvers<void>()
        const finalized = Promise.withResolvers<void>()
        yield* plugins.hook[kind](() =>
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.ensuring(Effect.sync(() => finalized.resolve())),
          ),
        ).pipe(Scope.provide(scope))
        const options = yield* PluginHooks.prepare(configuration, { store })
        const client = EngineClient.start({
          binary,
          workspace,
          db: path.join(tmp.path, "engine.db"),
          model: "fixture",
          provider: "openai-chat",
          endpoint: new URL("chat/completions", provider.url).toString(),
          policyFile,
          productToolsFile,
          ...options,
          env: { OPENAI_API_KEY: "fixture-only" },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
        yield* Effect.promise(() =>
          client.admit({ session_id: "ses_plugin_hooks", input_id: "native-hook", prompt: "read the file" }),
        )
        expect(
          yield* Effect.promise(() =>
            Promise.race([started.promise.then(() => true), Bun.sleep(3_000).then(() => false)]),
          ),
        ).toBe(true)
        yield* Effect.promise(() => client.cancel("ses_plugin_hooks"))
        expect(
          yield* Effect.promise(() =>
            Promise.race([finalized.promise.then(() => true), Bun.sleep(2_000).then(() => false)]),
          ),
        ).toBe(true)
      }),
    15_000,
  )
}
