import { describe, expect } from "bun:test"
import { Tool } from "@miao/core/tool/tool"
import { AgentV2 } from "@miao/core/agent"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ToolRegistry } from "@miao/core/tool/registry"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))

const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_code_mode"),
}
const sessionID = SessionV2.ID.make("ses_code_mode")

const settle = (
  materialized: ToolRegistry.Materialization,
  name: string,
  input: unknown,
  id = `call-${name}`,
) => materialized.settle({ sessionID, ...identity, call: { type: "tool-call", id, name, input } })

const echo = Tool.make({
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ text }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})

describe("ToolRegistry code mode", () => {
  it.effect("keeps the normal tool set when disabled", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo })

      const materialized = yield* service.materialize()

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["echo"])
    }),
  )

  it.effect("replaces the tool set with one execute tool when enabled", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo })

      const materialized = yield* service.materialize(undefined, { codeMode: true })

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["execute"])
    }),
  )

  it.effect("does not advertise execute when there are no tools", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const materialized = yield* service.materialize(undefined, { codeMode: true })

      expect(materialized.definitions).toEqual([])
    }),
  )

  it.effect("keeps the normal tool set when execute is denied", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo })

      const materialized = yield* service.materialize([{ action: "execute", resource: "*", effect: "deny" }], {
        codeMode: true,
      })

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["echo"])
    }),
  )

  it.effect("runs a program that calls a wrapped tool", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo })
      const materialized = yield* service.materialize(undefined, { codeMode: true })

      const settlement = yield* settle(materialized, "execute", {
        code: 'const result = await tools.miao.echo({ text: "hi" })\nreturn result.text',
      })

      expect(settlement.result).toEqual({ type: "text", value: "hi" })
    }),
  )

  it.effect("surfaces a program diagnostic as tool error text", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo })
      const materialized = yield* service.materialize(undefined, { codeMode: true })

      const settlement = yield* settle(materialized, "execute", { code: "return await tools.miao.missing({})" })

      expect(settlement.result.type).toBe("text")
      expect(String(settlement.result.value)).toContain("missing")
    }),
  )

  it.effect("propagates a child tool failure into the program result", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        boom: Tool.make({
          description: "Always fails",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.fail(new Tool.Failure({ message: "exploded" })),
        }),
      })
      const materialized = yield* service.materialize(undefined, { codeMode: true })

      const settlement = yield* settle(materialized, "execute", { code: "return await tools.miao.boom({})" })

      expect(String(settlement.result.value)).toContain("exploded")
    }),
  )
})
