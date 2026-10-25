import { expect, test } from "bun:test"
import { lastOutputAt, turnActivity, turnSummary } from "../src/routes/session/activity"
import { Locale } from "../src/util/locale"
import type { AssistantContent, SessionMessage, TranscriptAssistantMessage } from "@miao/schema/view-models"
import { testAssistantMessage, testReasoningPart, testTextPart, testToolPart, testUserMessage } from "./lib/v2-message"

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

function settledTurn(input: { opened: number; first: number; last: number }): SessionMessage[] {
  return [
    testUserMessage({ id: "msg_user", text: "do the thing", created: input.opened }),
    testAssistantMessage({ id: "msg_step_1", created: input.first, completed: input.first + 1000 }),
    testAssistantMessage({ id: "msg_step_2", created: input.last - 1000, completed: input.last }),
  ]
}

const settled = (opened: number, completed: number) =>
  `Worked for ${Locale.duration(completed - opened)} · done ${Locale.todayTimeOrDateTime(completed)}`

test("a settled turn reports its whole span, not only the last step", () => {
  const opened = Date.now() - 12_000
  expect(turnSummary({ messages: settledTurn({ opened, first: opened + 2000, last: opened + 12_000 }) })).toBe(
    settled(opened, opened + 12_000),
  )
})

test("only the last turn is summarized", () => {
  const opened = Date.now() - 5000
  const messages: SessionMessage[] = [
    testUserMessage({ id: "msg_old_user", text: "older", created: opened - 60_000 }),
    testAssistantMessage({ id: "msg_old", created: opened - 59_000, completed: opened - 58_000 }),
    ...settledTurn({ opened, first: opened + 1000, last: opened + 5000 }),
  ]
  expect(turnSummary({ messages })).toBe(settled(opened, opened + 5000))
})

test("a turn that has not settled has no summary", () => {
  const opened = Date.now() - 3000
  const messages: SessionMessage[] = [
    testUserMessage({ id: "msg_user", text: "still going", created: opened }),
    testAssistantMessage({ id: "msg_open", created: opened + 1000 }),
  ]
  expect(turnSummary({ messages })).toBeUndefined()
  expect(turnSummary({ messages: [testAssistantMessage({ id: "msg_only" })] })).toBeUndefined()
})

test("an interrupted turn says it stopped instead of claiming work", () => {
  const opened = Date.now() - 5000
  const tail: TranscriptAssistantMessage = {
    ...testAssistantMessage({ id: "msg_stopped", created: opened + 1000, completed: opened + 5000 }),
    error: { type: "unknown", message: "interrupted", interrupted: true },
  }
  expect(turnSummary({ messages: [testUserMessage({ id: "msg_user", text: "go", created: opened }), tail] })).toBe(
    `Stopped after ${Locale.duration(5000)} · done ${Locale.todayTimeOrDateTime(opened + 5000)}`,
  )
})

test("a failed tail is left to the error block", () => {
  const opened = Date.now() - 5000
  const tail: TranscriptAssistantMessage = {
    ...testAssistantMessage({ id: "msg_failed", created: opened + 1000, completed: opened + 5000 }),
    error: { type: "unknown", message: "provider failed" },
  }
  expect(turnSummary({ messages: [testUserMessage({ id: "msg_user", text: "go", created: opened }), tail] })).toBeUndefined()
})

test("background subagents keep a settled turn from reading as finished", () => {
  const opened = Date.now() - 5000
  const messages = settledTurn({ opened, first: opened + 1000, last: opened + 5000 })
  expect(turnSummary({ messages, background: 1 })).toBe(`${settled(opened, opened + 5000)} · 1 subagent still running`)
  expect(turnSummary({ messages, background: 2 })).toBe(`${settled(opened, opened + 5000)} · 2 subagents still running`)
})
