import { expect, test } from "bun:test"
import {
  latestSubagentPartID,
  orderTaskBlocks,
  subagentActivity,
  subagentResult,
  subagentRunning,
  toolActivity,
} from "../src/routes/session/activity"
import type { AssistantContent, TranscriptMessage, TranscriptToolPart } from "@miao/schema/view-models"
import { testAssistantMessage, testToolPart, testUserMessage } from "./lib/v2-message"

function tool(
  name: string,
  status: "running" | "completed" = "completed",
  input: Record<string, unknown> = {},
): TranscriptToolPart {
  return testToolPart(`prt_${name}_${Math.random().toString(36).slice(2)}`, name, status, {
    created: 1,
    completed: status === "completed" ? 2 : undefined,
    input,
  })
}

function partID(part: AssistantContent) {
  return part.type === "tool" ? part.id : undefined
}

test("toolActivity names a call in present tense while it runs and past tense after", () => {
  expect(toolActivity(tool("bash", "running", { command: "bun test" }))).toBe("running bun test")
  expect(toolActivity(tool("bash", "completed", { command: "bun test" }))).toBe("ran bun test")
  expect(toolActivity(tool("read", "running", { filePath: "src/a.ts" }))).toBe("reading src/a.ts")
})

test("toolActivity has no name for tools outside the live groups", () => {
  expect(toolActivity(tool("todowrite", "running"))).toBeUndefined()
  expect(toolActivity(tool("bash", "running", {}))).toBeUndefined()
})

test("subagentActivity keeps only the latest tool lines, newest last", () => {
  const messages: TranscriptMessage[] = [
    testUserMessage({ text: "go" }),
    testAssistantMessage({
      content: [tool("read", "completed", { filePath: "src/a.ts" }), tool("bash", "completed", { command: "bun test" })],
    }),
    testAssistantMessage({
      content: [tool("grep", "running", { pattern: "spinner" }), tool("todowrite", "completed")],
    }),
  ]
  expect(subagentActivity(messages)).toEqual(["read src/a.ts", "ran bun test", "searching for spinner"])
})

test("subagentActivity truncates from the oldest side so the newest call survives", () => {
  const messages: TranscriptMessage[] = [
    testAssistantMessage({
      content: [
        tool("read", "completed", { filePath: "src/a.ts" }),
        tool("bash", "completed", { command: "bun fmt" }),
        tool("bash", "running", { command: "bun test" }),
      ],
    }),
  ]
  expect(subagentActivity(messages, 2)).toEqual(["ran bun fmt", "running bun test"])
})

test("subagentActivity is empty before the child transcript loads", () => {
  expect(subagentActivity([testUserMessage({ text: "go" })])).toEqual([])
})

test("subagentRunning derives the spinner from the part and child status", () => {
  expect(subagentRunning("running", false, { type: "idle" })).toBe(true)
  expect(subagentRunning("running", false, undefined)).toBe(true)
  expect(subagentRunning("completed", false, { type: "busy" })).toBe(false)
  expect(subagentRunning("completed", true, { type: "busy" })).toBe(true)
  expect(subagentRunning("completed", true, { type: "idle" })).toBe(false)
  expect(subagentRunning("completed", true, undefined)).toBe(false)
  expect(subagentRunning("error", true, { type: "busy" })).toBe(false)
})

test("subagentResult previews the first line of the report", () => {
  expect(subagentResult(undefined)).toBeUndefined()
  expect(subagentResult("")).toBeUndefined()
  expect(subagentResult("\n\nsecond line")).toBe("second line")
  expect(subagentResult("found three bugs")).toBe("found three bugs")
  expect(subagentResult("x".repeat(80))).toBe(`${"x".repeat(60)}…`)
})

test("latestSubagentPartID picks the newest running block over settled ones", () => {
  const settledOld = tool("task", "completed", { description: "old" })
  const settledNew = tool("task", "completed", { description: "new" })
  const running = tool("task", "running", { description: "live" })
  const messages: TranscriptMessage[] = [
    testAssistantMessage({ content: [settledOld] }),
    testAssistantMessage({ content: [settledNew] }),
    testAssistantMessage({ content: [running] }),
  ]
  expect(latestSubagentPartID(messages)).toBe(partID(running))
})

test("latestSubagentPartID falls back to the newest settled block", () => {
  const settledOld = tool("task", "completed", { description: "old" })
  const settledNew = tool("task", "completed", { description: "new" })
  const messages: TranscriptMessage[] = [
    testAssistantMessage({ content: [settledOld] }),
    testUserMessage({ text: "next" }),
    testAssistantMessage({ content: [settledNew] }),
  ]
  expect(latestSubagentPartID(messages)).toBe(partID(settledNew))
})

test("latestSubagentPartID is undefined without task parts", () => {
  expect(latestSubagentPartID([testAssistantMessage({ content: [tool("bash")] })])).toBeUndefined()
  expect(latestSubagentPartID([])).toBeUndefined()
})

test("orderTaskBlocks moves running blocks above settled siblings in one tool group", () => {
  const settled = tool("task", "completed", { description: "done" })
  const running = tool("task", "running", { description: "live" })
  const bash = tool("bash")
  const ordered = orderTaskBlocks([settled, running, bash])
  expect(ordered.map(partID)).toEqual([partID(running), partID(settled), partID(bash)])
})

test("orderTaskBlocks keeps prose anchored between tool groups", () => {
  const settled = tool("task", "completed", { description: "done" })
  const running = tool("task", "running", { description: "live" })
  const text: AssistantContent = { type: "text", id: "prt_text", text: "meanwhile" }
  const ordered = orderTaskBlocks([settled, text, running])
  expect(ordered).toEqual([settled, text, running])
})

test("orderTaskBlocks preserves the running blocks' own arrival order", () => {
  const first = tool("task", "running", { description: "first" })
  const second = tool("task", "running", { description: "second" })
  const settled = tool("task", "completed", { description: "done" })
  expect(orderTaskBlocks([settled, second, first]).map(partID)).toEqual([
    partID(second),
    partID(first),
    partID(settled),
  ])
})
