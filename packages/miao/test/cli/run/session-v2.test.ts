import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { permissionRequest, transcriptEntries } from "@/cli/cmd/run/session-v2"

type Assistant = Extract<SessionMessage, { type: "assistant" }>

function assistant(content: Assistant["content"], completed?: number): SessionMessage {
  return {
    id: "msg_a",
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
    time: { created: 10, ...(completed === undefined ? {} : { completed }) },
    content,
  }
}

function entries(messages: SessionMessage[]) {
  return transcriptEntries({ sessionID: "ses_1", directory: "/tmp", messages })
}

function parts(messages: SessionMessage[]) {
  return entries(messages).flatMap((entry) => (entry.type === "message" ? entry.message.parts : []))
}

describe("run session v2 transcript", () => {
  test("scopes stream part ids by message and leaves user part ids alone", () => {
    const list = parts([
      { id: "msg_u", type: "user", text: "hi", time: { created: 1 } },
      assistant([
        { type: "reasoning", id: "r-0", text: "hmm" },
        { type: "text", id: "text-0", text: "hello" },
        {
          type: "tool",
          id: "call_1",
          name: "read",
          state: {
            status: "completed",
            input: { path: "a.ts" },
            structured: {},
            content: [{ type: "text", text: "x" }],
          },
          time: { created: 10, completed: 11 },
        },
      ]),
    ])

    expect(list.map((part) => part.id)).toEqual(["msg_u-text", "msg_a:r-0", "msg_a:text-0", "msg_a:call_1"])
    const tool = list.at(-1)
    expect(tool?.type === "tool" ? [tool.callID, tool.state.input] : undefined).toEqual([
      "call_1",
      { path: "a.ts", filePath: "a.ts" },
    ])
  })

  test("marks settled text and reasoning as ended and leaves streaming items open", () => {
    const finished = parts([
      assistant(
        [
          { type: "reasoning", id: "r-0", text: "" },
          { type: "text", id: "t-0", text: "" },
        ],
        20,
      ),
    ])
    expect(finished.map((part) => (part.type === "text" || part.type === "reasoning" ? part.time?.end : -1))).toEqual([
      20, 20,
    ])

    const streaming = parts([
      assistant([
        { type: "text", id: "t-0", text: "" },
        { type: "text", id: "t-1", text: "done" },
      ]),
    ])
    expect(streaming.map((part) => (part.type === "text" ? part.time?.end : -1))).toEqual([undefined, 10])
  })

  test("drops the model-facing bash status line but keeps output and warnings", () => {
    const bash = (content: Array<{ type: "text"; text: string }>) =>
      parts([
        assistant(
          [
            {
              type: "tool",
              id: "call_1",
              name: "bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                structured: { exit: 0, truncated: false },
                content,
              },
              time: { created: 10, completed: 11 },
            },
          ],
          12,
        ),
      ])[0]
    const output = (part: ReturnType<typeof bash>) =>
      part?.type === "tool" && part.state.status === "completed" ? part.state.output : undefined

    expect(
      output(
        bash([
          { type: "text", text: "a\nb\n" },
          { type: "text", text: "Command exited with code 0." },
        ]),
      ),
    ).toBe("a\nb\n")
    expect(
      output(
        bash([
          { type: "text", text: "a\n" },
          { type: "text", text: "Warnings:\n- sandbox off\n\nCommand exited with code 1." },
        ]),
      ),
    ).toBe("a\n\nWarnings:\n- sandbox off")
    // A backfilled legacy call has only its output.
    expect(output(bash([{ type: "text", text: "Command exited with code 0." }]))).toBe("Command exited with code 0.")
  })

  test("keeps shell runs and compactions in transcript order", () => {
    const list = entries([
      { id: "msg_u", type: "user", text: "hi", time: { created: 1 } },
      {
        id: "msg_s",
        type: "shell",
        callID: "call_s",
        command: "ls",
        output: "a.ts\n",
        time: { created: 2, completed: 3 },
      },
      { id: "msg_c", type: "compaction", reason: "auto", summary: "s", recent: "", time: { created: 4 } },
      { id: "msg_m", type: "model-switched", model: { providerID: "openai", id: "gpt-5" }, time: { created: 5 } },
    ])

    expect(list.map((entry) => entry.type)).toEqual(["message", "shell", "compaction"])
    expect(list[1]).toEqual({
      type: "shell",
      id: "msg_s",
      callID: "call_s",
      command: "ls",
      output: "a.ts\n",
      completed: true,
    })
  })

  test("maps a V2 permission ask onto the request the footer renders", () => {
    expect(
      permissionRequest({
        id: "per_1",
        sessionID: "ses_1",
        action: "edit",
        resources: ["src/a.ts"],
        save: ["*"],
        metadata: { filepath: "src/a.ts", diff: "@@" },
        source: { type: "tool", messageID: "msg_a", callID: "call_1" },
      }),
    ).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: { filepath: "src/a.ts", diff: "@@" },
      always: ["*"],
      tool: { messageID: "msg_a", callID: "call_1" },
    })
  })
})
