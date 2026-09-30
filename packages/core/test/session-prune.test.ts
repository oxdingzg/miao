import { expect, test } from "bun:test"
import { Message } from "@miao/llm"
import { SessionPrune } from "@miao/core/session/prune"
import { Token } from "@miao/core/util/token"

const CLEARED = "[older tool output cleared to save context]"

// Four characters per token, so a result asked for in tokens measures as tokens.
const tool = (id: string, tokens: number, extra: { name?: string; providerExecuted?: boolean } = {}) =>
  Message.tool({
    id,
    name: extra.name ?? "read",
    result: "x".repeat(tokens * 4),
    providerExecuted: extra.providerExecuted,
  })
const user = (id: string) => Message.make({ id, role: "user", content: "go" })
const cleared = (message: Message) =>
  message.content.some((part) => part.type === "tool-result" && part.result.value === CLEARED)

test("keeps the newest tool output within the budget and clears everything older", () => {
  const messages = [user("u1"), tool("a", 25_000), tool("b", 25_000), tool("c", 25_000), user("u2"), user("u3")]
  const pruned = SessionPrune.toolResults(messages)

  expect(pruned.map(cleared)).toEqual([false, true, true, false, false, false])
  // The stored history is untouched: pruning only shapes the outgoing request.
  expect(messages[1]!.content[0]!.type === "tool-result" && messages[1]!.content[0]!.result.value).toBe(
    "x".repeat(100_000),
  )
})

test("the two most recent user turns keep their tool output whatever it costs", () => {
  const messages = [
    user("u1"),
    tool("a1", 25_000),
    tool("a2", 25_000),
    user("u2"),
    tool("b1", 60_000),
    user("u3"),
    tool("c1", 60_000),
  ]
  const pruned = SessionPrune.toolResults(messages)

  expect(pruned.map(cleared)).toEqual([false, true, false, false, false, false, false])
})

test("clearing less than the minimum leaves the request alone", () => {
  const messages = [
    user("u1"),
    ...Array.from({ length: 16 }, (_, index) => tool(`t${index}`, 1_000)),
    tool("newest", 39_000),
    user("u2"),
    user("u3"),
  ]
  const pruned = SessionPrune.toolResults(messages)

  expect(pruned.map(cleared)).toEqual(messages.map(() => false))
})

test("a skill result is never cleared", () => {
  const messages = [
    user("u1"),
    tool("instructions", 100_000, { name: "skill" }),
    tool("output", 100_000),
    user("u2"),
    user("u3"),
  ]
  const pruned = SessionPrune.toolResults(messages)

  expect(pruned.map(cleared)).toEqual([false, false, true, false, false])
})

test("a provider-executed result is never cleared", () => {
  const messages = [
    user("u1"),
    tool("search", 100_000, { name: "web_search", providerExecuted: true }),
    tool("output", 100_000),
    user("u2"),
    user("u3"),
  ]
  const pruned = SessionPrune.toolResults(messages)

  expect(pruned.map(cleared)).toEqual([false, false, true, false, false])
})

test("an inline image costs its attachment ceiling, not its base64 length", () => {
  const image = Message.tool({
    id: "img",
    name: "read",
    result: {
      type: "content",
      value: [{ type: "file", uri: `data:image/png;base64,${"A".repeat(400_000)}`, mime: "image/png" }],
    },
  })
  const messages = [user("u1"), image, tool("output", 38_000), user("u2"), user("u3")]
  const pruned = SessionPrune.toolResults(messages)

  // The base64 alone would measure as six figures of tokens and evict the read.
  const part = image.content[0]!
  if (part.type !== "tool-result") throw new Error("expected the image read to be a tool result")
  expect(Token.estimate(JSON.stringify(part.result))).toBeGreaterThan(100_000)
  expect(pruned[1]).toBe(image)
})

test("leaves messages untouched when everything fits the budget", () => {
  const messages = [user("u1"), tool("a", 100), tool("b", 100), user("u2"), user("u3")]
  const pruned = SessionPrune.toolResults(messages)

  expect(pruned[1]).toBe(messages[1])
  expect(pruned[2]).toBe(messages[2])
})
