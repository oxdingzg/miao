import { expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { sessionContextToMessages } from "../src/context/session-v2"

const base = { sessionID: "ses_1", cwd: "/work", root: "/work" }

test("maps a user message into a user info plus a text part", () => {
  const messages: SessionMessage[] = [
    {
      id: "msg_u",
      type: "user",
      time: { created: 10 },
      text: "hello",
      files: [{ uri: "file:///a.png", mime: "image/png", name: "a.png" }],
    },
  ]
  const [mapped] = sessionContextToMessages({ ...base, messages })
  expect(mapped.info.role).toBe("user")
  expect(mapped.info.id).toBe("msg_u")
  expect(mapped.parts.map((part) => part.type)).toEqual(["text", "file"])
  expect(mapped.parts[0]).toMatchObject({ type: "text", text: "hello" })
})

test("maps assistant content and links parentID to the preceding user", () => {
  const messages: SessionMessage[] = [
    { id: "msg_u", type: "user", time: { created: 10 }, text: "hi" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 20, completed: 30 },
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
      content: [
        { type: "reasoning", id: "prt_r", text: "think" },
        { type: "text", id: "prt_t", text: "answer" },
      ],
    },
  ]
  const [, assistant] = sessionContextToMessages({ ...base, messages })
  expect(assistant.info.role).toBe("assistant")
  if (assistant.info.role !== "assistant") throw new Error("expected assistant")
  expect(assistant.info.parentID).toBe("msg_u")
  expect(assistant.info.modelID).toBe("gpt")
  expect(assistant.parts.map((part) => part.type)).toEqual(["reasoning", "text"])
})

test("maps a completed tool state to V1 output/title", () => {
  const messages: SessionMessage[] = [
    { id: "msg_u", type: "user", time: { created: 10 }, text: "run" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 20 },
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
      content: [
        {
          type: "tool",
          id: "prt_tool",
          name: "bash",
          time: { created: 20, ran: 21, completed: 22 },
          state: {
            status: "completed",
            input: { command: "ls" },
            structured: {},
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
    },
  ]
  const [, assistant] = sessionContextToMessages({ ...base, messages })
  const part = assistant.parts[0]
  if (part.type !== "tool") throw new Error("expected tool part")
  expect(part.tool).toBe("bash")
  expect(part.state).toMatchObject({ status: "completed", output: "ok", title: "bash" })
})

test("skips V2 meta messages", () => {
  const messages: SessionMessage[] = [
    { id: "msg_s", type: "agent-switched", time: { created: 1 }, agent: "build" },
    { id: "msg_c", type: "compaction", time: { created: 2 }, reason: "auto", summary: "s", recent: "r" },
    { id: "msg_u", type: "user", time: { created: 3 }, text: "hi" },
  ]
  const mapped = sessionContextToMessages({ ...base, messages })
  expect(mapped.map((entry) => entry.info.id)).toEqual(["msg_u"])
})
