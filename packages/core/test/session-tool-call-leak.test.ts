import { describe, expect, test } from "bun:test"
import { ToolCallLeak } from "@miao/core/session/tool-call-leak"

// A real leak from issue #2: DeepSeek V4 Flash framed a call with fullwidth
// pipe DSML markers and the provider flushed it as assistant text.
const DSML =
  '\n< | DSML | invoke name="bash">\n<parameter name="command">ls</parameter>\n</ | DSML | invoke>\n'

describe("ToolCallLeak.detect", () => {
  test("fires on the issue #2 DSML leak", () => {
    expect(ToolCallLeak.detect(DSML)).toBe(true)
  })

  test("fires on a fullwidth-pipe DSML envelope", () => {
    const text =
      '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash">\n<｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("fires on a complete Qwen XML block", () => {
    const text = "<tool_call>\n<function=read>\n<parameter=filePath>\n/tmp/a\n</parameter>\n</function>\n</tool_call>"
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("fires on a drifted Qwen function tag", () => {
    const text = "<function_bash>\n<parameter=command>\nls\n</parameter>\n</function>"
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("fires on a closed hermes JSON block", () => {
    const text = '<tool_call>\n{"name": "read", "arguments": {"filePath": "/tmp/a"}}\n</tool_call>'
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("fires on an unclosed wrapper holding a complete invoke", () => {
    const text = '<tool_calls>\n<invoke name="bash"><parameter name="command">ls</parameter></invoke>'
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("fires on a namespaced antml invoke", () => {
    const text = '<antml:invoke name="bash"><antml:parameter name="command">ls</antml:parameter></antml:invoke>'
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  // Field evidence 2026-10-04 (session `项目复盘与效果优化方案`, seq 3852): DeepSeek
  // V4 Flash wrote a call as text but the gateway ate every opening marker, so
  // the message ended on a long run of stray `</parameter></invoke>` closers with
  // no `<invoke` anywhere. The old detect() missed it (no opener, and the bare
  // `</invoke>` tail was not in CLOSING_TAIL), so the leak stayed in history and
  // was imitated every later turn.
  test("fires on a stray closer run with the openers eaten", () => {
    const text =
      "I traced the Enter handler. The overlay is harmless.\n" +
      "</parameter>\n</invoke>\n".repeat(8)
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("fires on the archived leak from seq 3852", async () => {
    const text = await Bun.file(new URL("./fixtures/tool-call-leak-seq3852.txt", import.meta.url)).text()
    expect(ToolCallLeak.detect(text)).toBe(true)
  })

  test("ignores a small number of stray closers in prose", () => {
    const text = "Close the block with </parameter> and </invoke>. That is all."
    expect(ToolCallLeak.detect(text)).toBe(false)
  })

  test("ignores plain prose", () => {
    expect(ToolCallLeak.detect("The refactor is complete. All tests pass.")).toBe(false)
  })

  test("ignores mid-text tag mentions that end in prose", () => {
    const text = "Use `<parameter=filePath>` to pass the path. The closing </parameter> tag is required."
    expect(ToolCallLeak.detect(text)).toBe(false)
  })

  test("ignores an empty string", () => {
    expect(ToolCallLeak.detect("")).toBe(false)
  })
})

const nudge = (text = ToolCallLeak.NUDGE) => ({
  type: "synthetic",
  text,
  metadata: { [ToolCallLeak.NUDGE_MARKER]: true },
})
const assistant = () => ({ type: "assistant" })
const skill = () => ({ type: "synthetic", text: "skill content" })
const user = () => ({ type: "user" })

describe("ToolCallLeak.isNudge", () => {
  test("accepts the exact nudge shape", () => {
    expect(ToolCallLeak.isNudge(nudge())).toBe(true)
  })

  test("rejects a synthetic message without the marker", () => {
    expect(ToolCallLeak.isNudge({ type: "synthetic" })).toBe(false)
  })

  test("rejects a marked non-synthetic message", () => {
    expect(ToolCallLeak.isNudge({ type: "user", metadata: { [ToolCallLeak.NUDGE_MARKER]: true } })).toBe(false)
  })
})

describe("ToolCallLeak.countAttempts", () => {
  test("zero without a nudge", () => {
    expect(ToolCallLeak.countAttempts([user(), assistant()])).toBe(0)
  })

  test("counts trailing nudges", () => {
    expect(ToolCallLeak.countAttempts([user(), assistant(), nudge(), assistant(), nudge()])).toBe(2)
  })

  test("a real user prompt resets the count", () => {
    expect(ToolCallLeak.countAttempts([user(), assistant(), nudge(), user(), assistant()])).toBe(0)
  })

  test("a skill synthetic is not a nudge", () => {
    expect(ToolCallLeak.countAttempts([skill()])).toBe(0)
  })

  test("empty history", () => {
    expect(ToolCallLeak.countAttempts([])).toBe(0)
  })
})

test("exports the integration contract", () => {
  expect(ToolCallLeak.MAX_ATTEMPTS).toBeGreaterThan(0)
  expect(ToolCallLeak.NUDGE_MARKER).toBe("toolCallLeakRecovery")
  expect(ToolCallLeak.NUDGE.length).toBeGreaterThan(0)
})
