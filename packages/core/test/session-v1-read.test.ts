import { describe, expect, test } from "bun:test"
import { SessionV1Read } from "@miao/core/session/v1-read"

const user = (text: string) => ({
  info: {
    id: "msg_u",
    sessionID: "ses_x",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  },
  parts: [{ id: "prt_1", sessionID: "ses_x", messageID: "msg_u", type: "text", text }],
})

const assistant = () => ({
  info: {
    id: "msg_a",
    sessionID: "ses_x",
    role: "assistant",
    time: { created: 2, completed: 4 },
    parentID: "msg_u",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0.01,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  },
  parts: [
    { id: "prt_2", sessionID: "ses_x", messageID: "msg_a", type: "text", text: "hi" },
    {
      id: "prt_3",
      sessionID: "ses_x",
      messageID: "msg_a",
      type: "tool",
      callID: "c1",
      tool: "bash",
      state: { status: "completed", input: { command: "ls" }, output: "out", title: "t", metadata: {}, time: { start: 2, end: 3 } },
    },
  ],
})

describe("SessionV1Read.map", () => {
  test("maps legacy user and assistant messages to V2 shapes", () => {
    const messages = SessionV1Read.map([user("hello") as never, assistant() as never])
    expect(messages[0]).toMatchObject({ type: "user", text: "hello" })
    expect(messages[1]).toMatchObject({
      type: "assistant",
      agent: "build",
      finish: "stop",
      content: [
        { type: "text", text: "hi" },
        { type: "tool", name: "bash", state: { status: "completed", content: [{ type: "text", text: "out" }] } },
      ],
    })
  })
})
