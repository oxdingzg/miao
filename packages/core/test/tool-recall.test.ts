import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@miao/core/session/message"
import { RecallTool } from "@miao/core/tool/recall"

const message = (value: Record<string, unknown>) => value as unknown as SessionMessage.Message

const user = (text: string) => message({ type: "user", id: "msg_user", text, files: [], agents: [] })

const assistantTool = (name: string, result: string) =>
  message({
    type: "assistant",
    id: "msg_assistant",
    content: [
      {
        type: "tool",
        id: "call",
        name,
        state: {
          status: "completed",
          input: { command: "grep -R secret" },
          content: [{ type: "text", text: result }],
          structured: {},
        },
      },
    ],
  })

describe("recall search", () => {
  test("matches message text case-insensitively with a bounded excerpt", () => {
    const entries = [{ seq: 1, message: user("the answer is the SECRET token abc123") }]

    const matches = RecallTool.search(entries, "secret", 10)

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ seq: 1, type: "user" })
    expect(matches[0].excerpt).toContain("SECRET token abc123")
  })

  test("finds content inside tool results", () => {
    const entries = [{ seq: 7, message: assistantTool("bash", "exit code 1: missing dependency") }]

    const matches = RecallTool.search(entries, "missing dependency", 10)

    expect(matches.map((match) => match.seq)).toEqual([7])
    expect(matches[0].excerpt).toContain("missing dependency")
  })

  test("reaches content a compaction moved out of the model window", () => {
    const entries = [
      { seq: 1, message: user("we decided to use sqlite for storage") },
      {
        seq: 2,
        message: message({
          type: "compaction",
          id: "msg_compaction",
          reason: "auto",
          summary: "summary of earlier work",
          recent: "recent context",
        }),
      },
    ]

    const matches = RecallTool.search(entries, "sqlite", 10)

    expect(matches.map((match) => match.seq)).toEqual([1])
  })

  test("reads synthetic and shell messages", () => {
    const entries = [
      { seq: 1, message: message({ type: "synthetic", id: "msg_goal", text: "<goal>Ship the release</goal>" }) },
      {
        seq: 2,
        message: message({
          type: "shell",
          id: "msg_shell",
          callID: "call",
          command: "npm test",
          output: "all tests passed",
        }),
      },
    ]

    expect(RecallTool.search(entries, "ship the release", 10).map((match) => match.seq)).toEqual([1])
    expect(RecallTool.search(entries, "all tests passed", 10).map((match) => match.seq)).toEqual([2])
  })

  test("returns nothing for an empty query and honours the limit", () => {
    const entries = [
      { seq: 1, message: user("needle one") },
      { seq: 2, message: user("needle two") },
      { seq: 3, message: user("needle three") },
    ]

    expect(RecallTool.search(entries, "   ", 10)).toEqual([])
    expect(RecallTool.search(entries, "needle", 2).map((match) => match.seq)).toEqual([1, 2])
  })
})
