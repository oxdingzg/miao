import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionMessage } from "@miao/core/session/message"
import { HistoryTool } from "@miao/core/tool/history"
import { Token } from "@miao/core/util/token"

const message = (value: Record<string, unknown>) => value as unknown as SessionMessage.Message

const user = (text: string) => message({ type: "user", id: "msg_user", text, files: [], agents: [] })

const entries = (texts: string[]) => texts.map((text, index) => ({ seq: index + 1, message: user(text) }))

describe("history page", () => {
  test("returns full message text from a position with the next page position", () => {
    const output = HistoryTool.page(entries(["first", "second", "third"]), { from: 2 })

    expect(output.messages.map((message) => [message.seq, message.text])).toEqual([
      [2, "second"],
      [3, "third"],
    ])
    expect(output.next).toBeUndefined()
  })

  test("stops at the message limit and reports where to resume", () => {
    const output = HistoryTool.page(entries(["a", "b", "c"]), { limit: 2 })

    expect(output.messages.map((message) => message.seq)).toEqual([1, 2])
    expect(output.next).toBe(3)
  })

  test("stops at the page token budget before the limit", () => {
    const output = HistoryTool.page(entries(["x".repeat(40_000), "x".repeat(40_000), "tail"]), {})

    expect(output.messages).toHaveLength(1)
    expect(output.next).toBe(2)
  })

  test("clips a single message larger than the whole page", () => {
    const output = HistoryTool.page(entries(["y".repeat(80_000)]), {})

    expect(output.messages).toHaveLength(1)
    expect(Token.estimate(output.messages[0].text)).toBeLessThanOrEqual(17_000)
    expect(output.messages[0].text).toContain("search the full message with the recall tool")
    expect(output.next).toBeUndefined()
  })

  test("skips messages with no text", () => {
    const switched = message({ type: "agent-switched", id: "msg_switch" })
    const output = HistoryTool.page([{ seq: 1, message: switched }, { seq: 2, message: user("real") }], {})

    expect(output.messages.map((message) => message.seq)).toEqual([2])
  })

  test("returns nothing past the end of the history", () => {
    const output = HistoryTool.page(entries(["only"]), { from: 9 })

    expect(output.messages).toHaveLength(0)
    expect(output.next).toBeUndefined()
  })
})

describe("history render", () => {
  test("renders positioned blocks and the continuation hint", () => {
    const [part] = HistoryTool.render(HistoryTool.page(entries(["a", "b", "c"]), { limit: 2 }))

    expect(part).toMatchObject({ type: "text" })
    expect(part.type === "text" && part.text).toContain("[#1 user]\na")
    expect(part.type === "text" && part.text).toContain("(more remains — continue with history(from: 3))")
  })

  test("renders an empty page as a miss", () => {
    const [part] = HistoryTool.render(HistoryTool.page(entries(["only"]), { from: 9 }))

    expect(part).toMatchObject({ type: "text", text: "No message at or after that position." })
  })
})
