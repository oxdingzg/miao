import { describe, expect } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { PluginPromise } from "@miao/core/plugin/promise"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { Tool } from "@miao/core/tool/tool"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { ToolRegistry } from "@miao/core/tool/registry"
import { define } from "@opencode-ai/plugin/v2/promise"
import { Deferred, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { host } from "./plugin/host"
import { testEffect } from "./lib/effect"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolPlugins.node, ToolRegistry.node]), [[ToolOutputStore.node, outputStore]]),
)

const sessionID = SessionV2.ID.make("ses_tool_plugins")
const calls: unknown[] = []
const echo = Tool.make({
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: (input) => Effect.sync(() => calls.push(input)).pipe(Effect.as({ text: input.text })),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})
const call = (input: unknown = { text: "hi" }): ToolRegistry.ExecuteInput => ({
  sessionID,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_plugins"),
  call: { type: "tool-call", id: "call-echo", name: "echo", input },
})

const setup = Effect.gen(function* () {
  calls.length = 0
  const registry = yield* ToolRegistry.Service
  yield* registry.register({ echo })
  return { registry, plugins: yield* ToolPlugins.Service }
})

const settle = (registry: ToolRegistry.Interface, input = call()) =>
  registry.materialize().pipe(Effect.flatMap((materialized) => materialized.settle(input)))

describe("ToolPlugins", () => {
  it.effect("tool.execute.before sees V1-shaped input and can replace the arguments", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      const seen: ToolPlugins.BeforeEvent[] = []
      yield* plugins.hook.before((event) => {
        seen.push({ ...event })
        event.args = { text: "rewritten" }
      })

      const settlement = yield* settle(registry)

      expect(seen).toEqual([{ tool: "echo", sessionID, callID: "call-echo", agent: "build", args: { text: "hi" } }])
      expect(calls).toEqual([{ text: "rewritten" }])
      expect(settlement.result).toEqual({ type: "text", value: "rewritten" })
    }),
  )

  it.effect("tool.execute.before rejects the call when a hook throws, without running the tool", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      yield* plugins.hook.before(() => {
        throw new Error("reading .env is not allowed")
      })

      const settlement = yield* settle(registry)

      expect(calls).toEqual([])
      expect(settlement.result.type).toBe("error")
      expect(String(settlement.result.value)).toContain("reading .env is not allowed")
    }),
  )

  it.effect("tool.execute.before rejects the call when an Effect hook fails", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      yield* plugins.hook.before(() => Effect.fail(new Error("denied by policy")))

      const settlement = yield* settle(registry)

      expect(calls).toEqual([])
      expect(String(settlement.result.value)).toContain("denied by policy")
    }),
  )

  it.effect("tool.execute.after can replace the model-facing output and sees the arguments", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      const seen: ToolPlugins.AfterEvent[] = []
      yield* plugins.hook.after((event) => {
        seen.push({ ...event })
        event.output = `${event.output} [redacted]`
      })

      const settlement = yield* settle(registry)

      expect(seen).toEqual([
        {
          tool: "echo",
          sessionID,
          callID: "call-echo",
          agent: "build",
          args: { text: "hi" },
          title: "",
          output: "hi",
          metadata: { text: "hi" },
        },
      ])
      expect(settlement.result).toEqual({ type: "text", value: "hi [redacted]" })
    }),
  )

  it.effect("a throwing tool.execute.after hook settles as a tool error instead of failing the turn", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      yield* plugins.hook.after(() => {
        throw new Error("after exploded")
      })

      const settlement = yield* settle(registry)

      expect(calls).toHaveLength(1)
      expect(settlement.result.type).toBe("error")
      expect(String(settlement.result.value)).toContain("after exploded")
    }),
  )

  it.effect("tool.execute.after is not called for failed tool calls", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      let called = false
      yield* plugins.hook.after(() => {
        called = true
      })

      const settlement = yield* settle(registry, call({ text: 1 }))

      expect(settlement.result.type).toBe("error")
      expect(called).toBe(false)
    }),
  )

  it.effect("tool.definition rewrites the advertised description and keeps definitions stable without hooks", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      const before = (yield* registry.materialize()).definitions
      expect((yield* registry.materialize()).definitions[0]).toBe(before[0])

      yield* plugins.hook.definition((event) => {
        if (event.tool === "echo") event.description = `${event.description} (audited)`
      })
      yield* plugins.hook.definition(() => {
        throw new Error("broken definition hook")
      })

      const after = (yield* registry.materialize()).definitions
      expect(after.map((definition) => definition.description)).toEqual(["Echo text (audited)"])
      expect(after[0]?.inputSchema).toEqual(before[0]?.inputSchema)
    }),
  )

  it.effect("closing a hook registration removes the hook", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      yield* Effect.scoped(
        plugins.hook.before((event) => {
          event.args = { text: "scoped" }
        }),
      )

      yield* settle(registry)

      expect(calls).toEqual([{ text: "hi" }])
    }),
  )

  it.effect("materialization waits for deferred tool loading", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let loads = 0
      // The registration outlives the load, like a custom tool registered in its loader's Scope.
      const scope = yield* Scope.make()
      yield* plugins.defer(
        Effect.sync(() => loads++).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(registry.register({ late: echo }).pipe(Scope.provide(scope), Effect.orDie)),
        ),
      )
      expect(loads).toBe(0)

      const first = yield* registry.materialize().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Deferred.succeed(gate, undefined)
      const materialized = yield* Fiber.join(first)
      yield* registry.materialize()

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["echo", "late"])
      expect(loads).toBe(1)
    }),
  )

  it.effect("Promise plugins register tool hooks through the V2 plugin context", () =>
    Effect.gen(function* () {
      const { registry, plugins } = yield* setup
      const plugin = PluginPromise.fromPromise(
        define({
          id: "guard",
          setup: async (context) => {
            await context.tool.before(async (event) => {
              if (event.args.text === "secret") throw new Error("blocked by guard plugin")
            })
          },
        }),
      )
      yield* plugin.effect(
        host({
          tool: {
            before: plugins.hook.before,
            after: plugins.hook.after,
            definition: plugins.hook.definition,
            register: plugins.provide,
          },
        }),
      )

      const blocked = yield* settle(registry, call({ text: "secret" }))
      const allowed = yield* settle(registry)

      expect(String(blocked.result.value)).toContain("blocked by guard plugin")
      expect(allowed.result).toEqual({ type: "text", value: "hi" })
      expect(calls).toEqual([{ text: "hi" }])
    }),
  )
})
