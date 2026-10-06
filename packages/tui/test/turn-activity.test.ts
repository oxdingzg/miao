import { expect, test } from "bun:test"
import { lastOutputAt, turnActivity } from "../src/routes/session/activity"
import type { AssistantContent } from "@miao/schema/view-models"
import { testReasoningPart, testTextPart, testToolPart } from "./lib/v2-message"

function reasoning(text: string, created: number, completed?: number): AssistantContent {
  return testReasoningPart(`prt_${text}_${created}`, text, { created, completed })
}

function tool(name: string, status: "completed" | "running" = "completed", input: Record<string, unknown> = {}): AssistantContent {
  return testToolPart(`prt_${name}_${status}`, name, status, { created: 1, completed: status === "completed" ? 2 : undefined, input })
}

test("counts accumulate across every step of a turn instead of per assistant message", () => {
  // V2 emits one assistant message per provider turn, so a per-message count
  // would always report a single command.
  const parts = [
    reasoning("first", 0, 1000),
    tool("bash"),
    reasoning("second", 2000, 3000),
    tool("bash"),
    reasoning("third", 4000, 5000),
    tool("bash"),
  ]
  expect(turnActivity({ parts, working: false })).toBe("Thought for 3.0s, ran 3 shell commands")
})

test("working turns report tools in present tense", () => {
  expect(turnActivity({ parts: [tool("bash"), tool("bash")], working: true })).toBe("running 2 shell commands")
})

test("in-flight reasoning replaces the recorded thought duration", () => {
  expect(turnActivity({ parts: [reasoning("done", 0, 2000), reasoning("open", 3000)], working: true })).toBe("Thinking")
})

test("tool families report their own noun and skip absent families", () => {
  const parts = [tool("read"), tool("grep"), tool("glob"), tool("edit"), tool("write"), tool("task")]
  expect(turnActivity({ parts, working: false })).toBe(
    "read 1 file, searched for 2 patterns, edited 2 files, delegated to 1 subagent",
  )
})

test("a running step counts while the turn is live", () => {
  const parts = [tool("bash"), tool("bash", "running"), tool("task", "running")]
  expect(turnActivity({ parts, working: true })).toBe("running 2 shell commands, delegating to 1 subagent")
})

test("a single running tool is named instead of counted", () => {
  const live = (name: string, input: Record<string, unknown>) =>
    turnActivity({ parts: [tool(name, "running", input)], working: true })

  expect(live("bash", { command: "bun test" })).toBe("running bun test")
  expect(live("read", { filePath: "src/a.ts" })).toBe("reading src/a.ts")
  expect(live("glob", { pattern: "**/*.ts" })).toBe("searching for **/*.ts")
  expect(live("websearch", { query: "effect v4" })).toBe("searching for effect v4")
  expect(live("edit", { filePath: "src/b.ts" })).toBe("editing src/b.ts")
  expect(live("task", { description: "audit the runner" })).toBe("delegating to audit the runner")
})

test("the named tool replaces its own family count rather than repeating it", () => {
  const parts = [tool("read"), tool("bash"), tool("bash"), tool("bash", "running", { command: "bun test" })]
  expect(turnActivity({ parts, working: true })).toBe("running bun test, reading 1 file")
})

test("several running tools stay a count so one name cannot hide the others", () => {
  const parts = [tool("bash", "running", { command: "bun test" }), tool("bash", "running", { command: "bun lint" })]
  expect(turnActivity({ parts, working: true })).toBe("running 2 shell commands")
})

test("a running tool whose input cannot be read falls back to its family count", () => {
  expect(turnActivity({ parts: [tool("bash", "running")], working: true })).toBe("running 1 shell command")
})

test("a long command is shortened to its first line", () => {
  const parts = [tool("bash", "running", { command: `${"x".repeat(80)}\nand more` })]
  expect(turnActivity({ parts, working: true })).toBe(`running ${"x".repeat(60)}…`)
})

test("running tools and text do not count as completed work", () => {
  const parts: AssistantContent[] = [tool("bash", "running"), testTextPart("prt_text", "hello")]
  expect(turnActivity({ parts, working: false })).toBeUndefined()
})

test("the live timer measures silence since the last output, not the turn", () => {
  // A running tool is silence by definition: nothing else can emit while it
  // holds the turn, so its own start is the moment output stopped.
  const running = [
    testToolPart("prt_running", "bash", "running", { created: 900 }),
  ] as AssistantContent[]
  expect(lastOutputAt(running, 100)).toBe(900)
  expect(lastOutputAt([reasoning("open", 5000)], 100)).toBe(5000)
  expect(lastOutputAt([testTextPart("prt_text", "streaming")], 100)).toBe(100)
})

test("a turn without any output measures from the prompt that opened it", () => {
  const pending = testToolPart("prt_pending", "bash", "pending")
  expect(lastOutputAt([], 42)).toBe(42)
  expect(lastOutputAt([pending], 42)).toBe(42)
  expect(lastOutputAt([], undefined)).toBeUndefined()
})
