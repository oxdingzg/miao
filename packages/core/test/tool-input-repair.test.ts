import { describe, expect } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { Tool } from "@miao/core/tool/tool"
import type { ToolCall } from "@miao/llm"
import { Effect, Schema } from "effect"
import { it } from "./lib/effect"

const context = {
  sessionID: SessionSchema.ID.make("ses_tool_input_repair"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_input_repair"),
  toolCallID: "call",
}

const probe = (aliases?: Record<string, ReadonlyArray<string>>) => {
  const seen: Array<{ count: number; label: string; enabled?: boolean }> = []
  const tool = Tool.make({
    description: "Read a count",
    input: Schema.Struct({
      count: Schema.Number,
      label: Schema.String,
      enabled: Schema.Boolean.pipe(Schema.optional),
    }),
    output: Schema.Struct({ count: Schema.Number, label: Schema.String }),
    ...(aliases === undefined ? {} : { aliases }),
    execute: (input) =>
      Effect.sync(() => {
        seen.push(input)
        return { count: input.count, label: input.label }
      }),
  })
  return { tool, seen }
}

const settle = (tool: ReturnType<typeof probe>["tool"], input: unknown) =>
  Tool.settle(tool, { type: "tool-call", id: "call", name: "probe", input } as ToolCall, context)

describe("tool input repair", () => {
  it.effect("reads numbers and booleans a model wrote as strings", () =>
    Effect.gen(function* () {
      const { tool, seen } = probe()
      yield* settle(tool, { count: "3", label: "42", enabled: "true" })
      expect(seen).toEqual([{ count: 3, label: "42", enabled: true }])
    }),
  )

  it.effect("keeps a string where the schema declares a string", () =>
    Effect.gen(function* () {
      const { tool, seen } = probe()
      yield* settle(tool, { count: 3, label: "300000" })
      expect(seen[0]?.label).toBe("300000")
    }),
  )

  it.effect("reads an optional number written as a string", () =>
    Effect.gen(function* () {
      const { tool, seen } = probe()
      yield* settle(tool, { count: 1, label: "x", enabled: "false" })
      expect(seen[0]?.enabled).toBe(false)
    }),
  )

  it.effect("moves an alias onto the canonical field", () =>
    Effect.gen(function* () {
      const { tool, seen } = probe({ count: ["total"] })
      yield* settle(tool, { total: "5", label: "x" })
      expect(seen[0]?.count).toBe(5)
    }),
  )

  it.effect("prefers the canonical field when both spellings are present", () =>
    Effect.gen(function* () {
      const { tool, seen } = probe({ count: ["total"] })
      yield* settle(tool, { count: 1, total: 9, label: "x" })
      expect(seen[0]?.count).toBe(1)
    }),
  )

  it.effect("still rejects a value no reading of it satisfies", () =>
    Effect.gen(function* () {
      const { tool } = probe()
      const error = yield* settle(tool, { count: "three", label: "x" }).pipe(Effect.flip)
      expect(error.message).toContain("Invalid tool input")
    }),
  )
})
