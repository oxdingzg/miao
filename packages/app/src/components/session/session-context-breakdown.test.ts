import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@miao/schema/view-models"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"
import { estimateSessionContextHistory } from "./session-context-breakdown"
import { contentParts } from "@miao/session-ui/content"
import type { SessionMessageInfo } from "@/utils/server"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [
      { id: "u1", type: "user" },
      { id: "a1", type: "assistant" },
    ]
    const parts = {
      u1: [{ type: "text", text: "hello world" }] as unknown as Part[],
      a1: [{ type: "text", text: "assistant response" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [
      { id: "u1", type: "user" },
      { id: "a1", type: "assistant" },
    ]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(400) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(400) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })
})

const record = (id: string, time: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: null,
  content: [{ type: "text", id: "text", text: "x".repeat(40) }],
  tokens: { input: 100, output: 1000, reasoning: 1000, cache: { read: 20, write: 10 } },
  time: { created: time, completed: time + 1 },
})

describe("estimateSessionContextHistory", () => {
  test("uses each loaded prefix and does not attribute a response to its own request", () => {
    const messages: SessionMessageInfo[] = [
      { id: "user", type: "user", text: "abcd", time: { created: 0 } },
      record("first", 1),
      record("second", 2),
    ]
    const points = estimateSessionContextHistory({ messages, parts: contentParts("session", messages) })
    expect(points.map((point) => point.total)).toEqual([130, 130])
    expect(points[0].segments.find((segment) => segment.key === "assistant")).toBeUndefined()
    expect(points[1].segments.find((segment) => segment.key === "assistant")?.tokens).toBe(10)
    expect(points[0].segments.find((segment) => segment.key === "user")?.tokens).toBe(1)
    expect(
      points.every((point) => point.segments.reduce((sum, segment) => sum + segment.tokens, 0) === point.total),
    ).toBe(true)
  })

  test("resets historical user and assistant attribution after a checkpoint", () => {
    const messages: SessionMessageInfo[] = [
      { id: "user", type: "user", text: "abcd", time: { created: 0 } },
      record("first", 1),
      { id: "compact", type: "compaction", reason: "auto", summary: "abcd", recent: "abcd", time: { created: 3 } },
      record("after", 4),
    ]
    const points = estimateSessionContextHistory({ messages, parts: contentParts("session", messages) })
    expect(points[1].segments.map((segment) => segment.key)).toEqual(["other"])
    expect(points[1].segments[0].tokens).toBe(130)
  })

  test("keeps unknown prefixes in Other and bounds displayed history", () => {
    const messages = Array.from({ length: 100 }, (_, index) => record(`step-${index}`, index))
    const points = estimateSessionContextHistory({ messages, parts: contentParts("session", messages) })
    expect(points).toHaveLength(80)
    expect(points[0].id).toBe("step-20")
    const missing = estimateSessionContextHistory({ messages: [record("only", 1)], parts: {} })
    expect(missing[0].segments).toEqual([{ key: "other", tokens: 130, width: 100, percent: 100 }])
  })
})
