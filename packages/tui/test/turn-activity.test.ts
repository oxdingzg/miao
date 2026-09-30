import { expect, test } from "bun:test"
import { turnActivity } from "../src/routes/session/activity"
import type { Part } from "@opencode-ai/sdk/v2"

const base = { id: "part", sessionID: "ses_test", messageID: "msg_assistant" }

function reasoning(text: string, start: number, end?: number): Part {
  return { ...base, type: "reasoning", text, time: end === undefined ? { start } : { start, end } }
}

function tool(
  name: string,
  status: "completed" | "running" = "completed",
  input: Record<string, unknown> = {},
): Part {
  const state =
    status === "completed"
      ? { status, input, raw: "", output: "", title: "", metadata: {}, time: { start: 1, end: 2 } }
      : { status, input, raw: "", time: { start: 1 } }
  return { ...base, type: "tool", tool: name, callID: `call_${name}_${status}`, state } as Part
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
  const parts = [
    tool("bash", "running", { command: "bun test" }),
    tool("bash", "running", { command: "bun lint" }),
  ]
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
  const parts: Part[] = [tool("bash", "running"), { ...base, type: "text", text: "hello" }]
  expect(turnActivity({ parts, working: false })).toBeUndefined()
})
