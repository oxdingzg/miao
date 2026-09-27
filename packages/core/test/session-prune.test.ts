import { expect, test } from "bun:test"
import { Message } from "@miao/llm"
import { SessionPrune } from "@miao/core/session/prune"

const tool = (id: string, size: number) => Message.tool({ id, name: "read", result: "x".repeat(size) })

test("keeps the newest tool output and clears older ones past the budget", () => {
  const messages = [tool("a", 1_000), tool("b", 1_000), tool("c", 1_000)]
  const pruned = SessionPrune.toolResults(messages, 1_500)

  expect(pruned[2]!.content[0]!.type === "tool-result" && pruned[2]!.content[0]!.result.type).toBe("json")
  expect(pruned[0]!.content[0]!.type === "tool-result" && pruned[0]!.content[0]!.result.value).toBe(
    "[older tool output cleared to save context]",
  )
  expect(pruned[1]!.content[0]!.type === "tool-result" && pruned[1]!.content[0]!.result.value).toBe(
    "[older tool output cleared to save context]",
  )
})

test("leaves messages untouched when everything fits the budget", () => {
  const messages = [tool("a", 100), tool("b", 100)]
  const pruned = SessionPrune.toolResults(messages, 100_000)

  expect(pruned[0]).toBe(messages[0])
  expect(pruned[1]).toBe(messages[1])
})
