import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@miao/schema/view-models"
import { reasoningDone, reasoningSummary } from "../../../src/context/thinking"

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
