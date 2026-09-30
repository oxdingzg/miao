import { describe, expect, test } from "bun:test"
import { type ToolResultInput, toolResultSummary } from "./message-part-tool-result"

const i18n = {
  locale: () => "en",
  t: (key: string) => key,
  plural: (key: string, count: number) => `${key}:${count}`,
} as unknown as Parameters<typeof toolResultSummary>[1]

const part = (input: Partial<ToolResultInput>) => ({ metadata: {}, tool: "", ...input }) as ToolResultInput

describe("toolResultSummary", () => {
  test("counts grep matches from the structured payload", () => {
    expect(toolResultSummary(part({ tool: "grep", status: "completed", metadata: { value: [1, 2, 3] } }), i18n)).toBe(
      "ui.tool.result.grep:3",
    )
  })

  test("counts glob files from the structured payload", () => {
    expect(toolResultSummary(part({ tool: "glob", status: "completed", metadata: { value: [] } }), i18n)).toBe(
      "ui.tool.result.glob:0",
    )
  })

  test("counts read lines, falling back to the projected output", () => {
    expect(toolResultSummary(part({ tool: "read", status: "completed", metadata: { content: "a\nb\nc" } }), i18n)).toBe(
      "ui.tool.result.read:3",
    )
    expect(toolResultSummary(part({ tool: "read", status: "completed", output: "a\nb" }), i18n)).toBe(
      "ui.tool.result.read:2",
    )
  })

  test("reports a directory read as listed entries", () => {
    expect(toolResultSummary(part({ tool: "read", status: "completed", metadata: { entries: [{}, {}] } }), i18n)).toBe(
      "ui.tool.result.list:2",
    )
  })

  test("stays silent while the tool is unfinished or has nothing countable", () => {
    expect(toolResultSummary(part({ tool: "grep", status: "running", metadata: { value: [1] } }), i18n)).toBeUndefined()
    expect(toolResultSummary(part({ tool: "bash", status: "completed", metadata: { exit: 0 } }), i18n)).toBeUndefined()
    expect(toolResultSummary(part({ tool: "grep", status: "completed", metadata: {} }), i18n)).toBeUndefined()
  })
})
