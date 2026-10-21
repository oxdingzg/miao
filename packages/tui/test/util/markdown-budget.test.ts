import { expect, test } from "bun:test"
import { createMarkdownBudget, markdownCost } from "../../src/util/markdown-budget"

test("reservations share a limit and release/update without double counting", () => {
  const budget = createMarkdownBudget(100)
  const a = budget.lease()
  const b = budget.lease()
  expect(a.reserve(60)).toBe(true)
  expect(b.reserve(50)).toBe(false)
  expect(a.reserve(80)).toBe(true)
  expect(b.reserve(20)).toBe(true)
  expect(a.reserve(90)).toBe(false)
  expect(b.reserve(100)).toBe(true)
  b.release()
  b.release()
  expect(a.reserve(100)).toBe(true)
  expect(b.reserve(1)).toBe(false)
})

test("dense tables/lists cost handles but long fenced code and prose do not", () => {
  expect(markdownCost("| a | b |\n".repeat(1000))).toBeGreaterThan(12000)
  expect(markdownCost("- item\n".repeat(1000))).toBeGreaterThan(12000)
  expect(markdownCost("word ".repeat(100000))).toBeLessThan(100)
  expect(markdownCost("```ts\n" + "a | b\n".repeat(10000) + "```\n")).toBeLessThan(100)
  expect(markdownCost("~~~\n```\n" + "a | b\n".repeat(10000) + "~~~\n")).toBeLessThan(100)
})
