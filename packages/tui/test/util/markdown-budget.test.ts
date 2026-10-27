import { expect, test } from "bun:test"
import { createMarkdownBudget, markdownCost } from "../../src/util/markdown-budget"

test("the pool is handed out from the newest message backwards", async () => {
  const budget = createMarkdownBudget(100)
  const granted: Record<string, boolean> = {}
  const older = budget.lease(60, (rich) => (granted.older = rich))
  budget.lease(60, (rich) => (granted.newer = rich))
  await Bun.sleep(0)
  expect(granted).toEqual({ older: false, newer: true })
  older.release()
  expect(granted).toEqual({ older: false, newer: true })
})

test("a cost update re-runs the assignment and a release returns the handles", async () => {
  const budget = createMarkdownBudget(100)
  const granted: Record<string, boolean> = {}
  const older = budget.lease(60, (rich) => (granted.older = rich))
  const newer = budget.lease(60, (rich) => (granted.newer = rich))
  await Bun.sleep(0)
  expect(granted).toEqual({ older: false, newer: true })
  newer.update(30)
  await Bun.sleep(0)
  expect(granted).toEqual({ older: true, newer: true })
  newer.update(90)
  await Bun.sleep(0)
  expect(granted).toEqual({ older: false, newer: true })
  newer.release()
  await Bun.sleep(0)
  expect(granted).toEqual({ older: true, newer: true })
  older.release()
})

test("dense tables/lists cost handles but long fenced code and prose do not", () => {
  expect(markdownCost("| a | b |\n".repeat(1000))).toBeGreaterThan(12000)
  expect(markdownCost("- item\n".repeat(1000))).toBeGreaterThan(12000)
  expect(markdownCost("word ".repeat(100000))).toBeLessThan(100)
  expect(markdownCost("```ts\n" + "a | b\n".repeat(10000) + "```\n")).toBeLessThan(100)
  expect(markdownCost("~~~\n```\n" + "a | b\n".repeat(10000) + "~~~\n")).toBeLessThan(100)
})

test("the conservative bound counts CR-only lines, nested markers and escaped table separators", () => {
  expect(markdownCost("- item\r".repeat(1000))).toBeGreaterThan(12000)
  expect(markdownCost("\\|a\\|b\\|\n".repeat(1000))).toBeGreaterThan(12000)
  expect(markdownCost("- ".repeat(1000) + "nested")).toBeGreaterThan(12000)
  expect(markdownCost(">".repeat(1000) + "nested")).toBeGreaterThan(12000)
})

test("an invalid backtick info string cannot hide a costly table from the budget", () => {
  expect(markdownCost("```invalid`info\n" + "|a|b|\n".repeat(1000))).toBeGreaterThan(12000)
})

test("a prose paragraph is one renderable, whatever its line count", () => {
  const paragraph = "the same sentence over and over\n".repeat(500)
  expect(markdownCost(paragraph)).toBeLessThan(100)
  expect(markdownCost(paragraph.repeat(10))).toBeLessThan(200)
})

