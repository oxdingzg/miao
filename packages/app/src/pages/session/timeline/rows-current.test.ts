import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@/utils/server"
import type { UserMessage } from "@miao/schema/view-models"
import { normalizeSessionMessages } from "@/utils/session-message"

mock.module("@miao/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

const { Timeline, TimelineRow } = await import("./rows")

describe("current session timeline rows", () => {
  test("derives turns and tagged rows from chronological current messages", () => {
    const source = [
      { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", id: "txt_1", text: "answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_3", type: "user", text: "second", time: { created: 4 } },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "reasoning", id: "rsn_1", text: "working" }],
        time: { created: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      [],
    )

    expect(result.activeMessageID).toBe("msg_3")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_1",
      "assistant-part:msg_1:msg_2:text:0",
      "turn-gap:msg_3",
      "user-message:msg_3",
      "assistant-part:msg_3:msg_4:reasoning:0",
    ])
  })

  test("renders a current shell message as a standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        callID: "shell_1",
        command: "pwd",
        output: "/repo",
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      [],
    )

    expect(result.activeMessageID).toBe("msg_shell")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_shell",
      "assistant-part:msg_shell:msg_shell:tool",
    ])
  })

  test("keeps a projected parent missing from the source page before newer turns", () => {
    const source = [
      { id: "msg_user_1", type: "user", text: "first question", time: { created: 1 } },
      {
        id: "msg_assistant_1",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", id: "txt_1", text: "first answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_user_2", type: "user", text: "second question", time: { created: 4 } },
      {
        id: "msg_assistant_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", id: "txt_1", text: "second answer" }],
        time: { created: 5, completed: 6 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)

    const result = Timeline.constructSessionMessageRows(
      source.slice(1),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      [],
    )

    // V2-native construction renders the fetched page only; off-page history
    // arrives through the timeline's older-page loading.
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_user_2",
      "assistant-part:msg_user_2:msg_assistant_2:text:0",
    ])
  })

  test("renders an optimistic user turn and thinking before the protocol message arrives", () => {
    const source = [
      { id: "msg_z", type: "user", text: "existing", time: { created: 1 } },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const optimistic = {
      id: "msg_a",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 2 },
      agent: "build",
      model: { modelID: "model", providerID: "provider" },
    }
    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => (messageID === optimistic.id ? [] : (normalized.parts.get(messageID) ?? [])),
      true,
      "busy",
      true,
      [...normalized.messages.filter((message) => message.role === "user"), optimistic] as unknown as UserMessage[],
    )

    expect(result.activeMessageID).toBe(optimistic.id)
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_z",
      "turn-gap:msg_a",
      "user-message:msg_a",
      "thinking:msg_a",
    ])
  })

  test("removes a failed assistant error when the turn continues streaming", () => {
    const source = [
      { id: "msg_user", type: "user", text: "recover", time: { created: 1 } },
      {
        id: "msg_failed",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "unknown", message: "temporary failure" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_recovery",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", id: "txt_1", text: "streaming again" }],
        time: { created: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      [],
    )

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
  })

  test("renders the interrupted divider for every abort signal shape", () => {
    const signals: Array<Record<string, unknown>> = [
      { finish: "aborted" },
      { error: { type: "unknown", message: "Provider turn interrupted" } },
      { error: { type: "MessageAbortedError", message: "Stopped" } },
      { error: { name: "MessageAbortedError", data: { message: "Stopped" } } },
    ]
    for (const signal of signals) {
      const source = [
        { id: "msg_1", type: "user", text: "go", time: { created: 1 } },
        {
          id: "msg_2",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [],
          time: { created: 2, completed: 3 },
          ...signal,
        },
        {
          id: "msg_3",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [],
          time: { created: 4, completed: 5 },
        },
      ] as SessionMessageInfo[]

      const result = Timeline.constructSessionMessageRows(source, () => [], true, "idle", true, [])

      expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "TurnDivider"])
    }
  })

  test("suppresses the error row only when the final message is the aborted one", () => {
    const abortedLast = [
      { id: "msg_1", type: "user", text: "go", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "unknown", message: "Provider turn interrupted" },
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const failedLast = [
      { id: "msg_1", type: "user", text: "go", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "unknown", message: "Provider rate limited" },
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]

    const aborted = Timeline.constructSessionMessageRows(abortedLast, () => [], true, "idle", true, [])
    const failed = Timeline.constructSessionMessageRows(failedLast, () => [], true, "idle", true, [])

    expect(aborted.rows.map((row) => row._tag)).toEqual(["UserMessage", "TurnDivider"])
    expect(failed.rows.map((row) => row._tag)).toEqual(["UserMessage", "Error"])
  })
})
