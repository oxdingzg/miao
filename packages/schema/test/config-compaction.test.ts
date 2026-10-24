import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCompaction } from "../src/config/compaction"

const decode = (value: unknown) => Schema.decodeUnknownSync(ConfigCompaction.Info)(value)

test("compaction.max_context accepts scalar and keyed-map budgets", () => {
  expect(decode({ max_context: "300K" }).max_context).toBe("300K")
  expect(decode({ max_context: 200_000 }).max_context).toBe(200_000)
  expect(decode({ max_context: { "openai/gpt-5*": "300K", "openai/gpt-5.6": 200_000 } }).max_context).toEqual({
    "openai/gpt-5*": "300K",
    "openai/gpt-5.6": 200_000,
  })
})

test("compaction.max_context omits undefined and rejects malformed budgets", () => {
  expect("max_context" in decode({})).toBe(false)
  expect(() => decode({ max_context: { "openai/gpt-5": ["300K"] } })).toThrow()
})
