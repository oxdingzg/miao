import { expect, test } from "bun:test"
import { turnActivity } from "../src/routes/session/activity"
import type { Part } from "@opencode-ai/sdk/v2"

const base = { id: "part", sessionID: "ses_test", messageID: "msg_assistant" }

function reasoning(text: string, start: number, end?: number): Part {
  return { ...base, type: "reasoning", text, time: end === undefined ? { start } : { start, end } }
}

function tool(name: string, status: "completed" | "running" = "completed"): Part {
  const state =
    status === "completed"
      ? { status, input: {}, raw: "", output: "", title: "", metadata: {}, time: { start: 1, end: 2 } }
      : { status, input: {}, raw: "", time: { start: 1 } }
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
  expect(turnActivity({ parts, working: false })).toBe("read 1 file, searched for 2 patterns, edited 2 files")
})

test("running tools and text do not count as completed work", () => {
  const parts: Part[] = [tool("bash", "running"), { ...base, type: "text", text: "hello" }]
  expect(turnActivity({ parts, working: false })).toBeUndefined()
})
