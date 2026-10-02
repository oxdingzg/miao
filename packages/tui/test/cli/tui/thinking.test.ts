import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { reasoningDone, reasoningHeadline, reasoningSummary } from "../../../src/context/thinking"

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })
  })
})

describe("reasoningHeadline", () => {
  test("uses the summary title when the provider sends one", () => {
    expect(reasoningHeadline("**Inspecting PR workflow**\n\nReading the workflow file.")).toBe("Inspecting PR workflow")
  })

  test("falls back to the first sentence of plain reasoning", () => {
    expect(reasoningHeadline("Let me look at the footer around line 363. Then check the editor.")).toBe(
      "Let me look at the footer around line 363.",
    )
    expect(reasoningHeadline("先看一下 editor.ts 的实现。再决定怎么改。")).toBe("先看一下 editor.ts 的实现。")
  })

  test("skips markdown markers and blank lines", () => {
    expect(reasoningHeadline("\n\n- **Check** the `run` command\nmore")).toBe("Check the run command")
  })

  test("truncates a long first sentence to one line", () => {
    const headline = reasoningHeadline("a".repeat(200))
    expect(headline).toHaveLength(80)
    expect(headline?.endsWith("…")).toBe(true)
  })

  test("returns null for empty reasoning", () => {
    expect(reasoningHeadline("   ")).toBeNull()
  })
})

describe("reasoningDone", () => {
  const part = (end?: number) => ({ time: { start: 1, end } })
  const message = (input: Partial<Pick<AssistantMessage, "time" | "error">> = {}) => ({
    time: { created: 1 },
    ...input,
  })

  test("is live while the part streams in a working session", () => {
    expect(reasoningDone(part(), message(), { type: "busy" })).toBe(false)
    expect(reasoningDone(part(), message())).toBe(false)
  })

  test("ends when the part ends, before its message completes", () => {
    expect(reasoningDone(part(5), message(), { type: "busy" })).toBe(true)
  })

  // History written before V2 reasoning carried timestamps has no end at all,
  // and its spinner repainted the whole screen ~12 times a second forever.
  test("ends with its message when the part never got an end", () => {
    expect(reasoningDone(part(), message({ time: { created: 1, completed: 9 } }), { type: "busy" })).toBe(true)
  })

  test("ends when an interrupted turn left the message errored or the session idle", () => {
    expect(reasoningDone(part(), message({ error: { name: "UnknownError", data: { message: "aborted" } } }))).toBe(true)
    expect(reasoningDone(part(), message(), { type: "idle" })).toBe(true)
  })
})
