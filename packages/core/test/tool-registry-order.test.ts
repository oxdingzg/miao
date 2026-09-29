import { describe, expect, test } from "bun:test"
import { Tool } from "@miao/core/tool/tool"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { SessionV2 } from "@miao/core/session"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ToolRegistry } from "@miao/core/tool/registry"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))

const echo = Tool.make({
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ text }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})

const tool = (description: string) =>
  Tool.make({
    description,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: () => Effect.succeed({}),
    toModelOutput: () => [{ type: "text", text: description }],
  })

describe("stableToolOrder", () => {
  test("preserves the previous order and appends new names", () => {
    expect(ToolRegistry.stableToolOrder(["a", "b", "c"], ["c", "a", "d"])).toEqual(["a", "c", "d"])
  })

  test("drops removed names without reordering the rest", () => {
    expect(ToolRegistry.stableToolOrder(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"])
  })

  test("returns the current order on a cold start", () => {
    expect(ToolRegistry.stableToolOrder([], ["b", "a"])).toEqual(["b", "a"])
  })
})

describe("ToolRegistry stable definitions", () => {
  it.effect("appends session tools and keeps the prefix stable across turns", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_stable_order")
      yield* service.register({ echo })
      const first = yield* service.materialize(undefined, { sessionID })
      expect(first.definitions.map((definition) => definition.name)).toEqual(["echo"])

      yield* service.registerSession(sessionID, { task: tool("task") })
      const second = yield* service.materialize(undefined, { sessionID })
      expect(second.definitions.map((definition) => definition.name)).toEqual(["echo", "task"])

      const third = yield* service.materialize(undefined, { sessionID })
      expect(third.definitions.map((definition) => definition.name)).toEqual(["echo", "task"])
    }),
  )

  it.effect("filters disabled tools and appends them when re-enabled", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_disabled_tools")
      yield* service.register({ echo, task: tool("task"), glob: tool("glob") })

      const all = yield* service.materialize(undefined, { sessionID })
      expect(all.definitions.map((definition) => definition.name)).toEqual(["echo", "task", "glob"])

      const withoutTask = yield* service.materialize(undefined, { sessionID, disabledTools: ["task"] })
      expect(withoutTask.definitions.map((definition) => definition.name)).toEqual(["echo", "glob"])

      // Re-enabling keeps the established prefix and only appends the tool.
      const reenabled = yield* service.materialize(undefined, { sessionID })
      expect(reenabled.definitions.map((definition) => definition.name)).toEqual(["echo", "glob", "task"])
    }),
  )
})
