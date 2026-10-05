import { expect, test } from "bun:test"
import { statusPhase, waitingForResponse, watchSessionStatus } from "../src/context/session-status"
import { sessionContextToMessages } from "../src/context/session-v2"

const [user, assistant] = sessionContextToMessages({
  sessionID: "ses_test",
  cwd: "/work",
  root: "/work",
  messages: [
    { id: "msg_user", type: "user", text: "hello", time: { created: 1 } },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { id: "test", providerID: "test" },
      time: { created: 2 },
      content: [],
    },
  ],
})
const assistantInfo = assistant.info
if (assistantInfo.role !== "assistant") throw new Error("Expected assistant")
const part = { id: "part", sessionID: "ses_test", messageID: "msg_assistant" }

test("busy execution is visible before the assistant or its first readable frame exists", () => {
  expect(waitingForResponse({ busy: true, blocked: false, parts: [] })).toBe(true)
  expect(waitingForResponse({ busy: true, blocked: false, message: user.info, parts: user.parts })).toBe(true)
  expect(waitingForResponse({ busy: true, blocked: false, message: assistantInfo, parts: [] })).toBe(true)
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistantInfo,
      parts: [{ ...part, type: "reasoning", text: "", time: { start: 2 }, metadata: { itemId: "opaque" } }],
    }),
  ).toBe(true)
})

test("idle, interrupted and blocked execution do not show a false provider wait", () => {
  expect(waitingForResponse({ busy: false, blocked: false, message: user.info, parts: user.parts })).toBe(false)
  expect(waitingForResponse({ busy: true, blocked: true, message: user.info, parts: user.parts })).toBe(false)
  expect(
    waitingForResponse({
      busy: false,
      blocked: false,
      message: { ...assistantInfo, time: { created: 2, completed: 3 } },
      parts: [],
    }),
  ).toBe(false)
})

test("readable text, reasoning or tool progress replaces the initial waiting indicator", () => {
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistantInfo,
      parts: [{ ...part, type: "text", text: "hello" }],
    }),
  ).toBe(false)
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistantInfo,
      parts: [{ ...part, type: "reasoning", text: "thinking", time: { start: 2 } }],
    }),
  ).toBe(false)
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistantInfo,
      parts: [
        { ...part, type: "tool", tool: "bash", callID: "call", state: { status: "pending", input: {}, raw: "" } },
      ],
    }),
  ).toBe(false)
})

test("an active continuation shows waiting again after the previous step finishes", () => {
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: { ...assistantInfo, time: { created: 2, completed: 3 }, finish: "tool-calls" },
      parts: [{ ...part, type: "text", text: "previous step" }],
    }),
  ).toBe(true)
})

test("status polling detects idle without needing a terminal content event", async () => {
  const statuses: string[] = []
  const idle = Promise.withResolvers<void>()
  let calls = 0
  const stop = watchSessionStatus({
    interval: 10,
    read: async () => (++calls === 1 ? "busy" : "idle"),
    onStatus: (status) => {
      statuses.push(status)
      if (status === "idle") idle.resolve()
    },
    onError: idle.reject,
  })
  try {
    await idle.promise
    expect(statuses).toEqual(["busy", "idle"])
  } finally {
    stop()
  }
})

test("slow status requests do not overlap and disposal ignores late responses", async () => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<"busy" | "idle">()
  const statuses: string[] = []
  let calls = 0
  const stop = watchSessionStatus({
    interval: 10,
    read: () => {
      calls++
      started.resolve()
      return response.promise
    },
    onStatus: (status) => statuses.push(status),
    onError: started.reject,
  })
  await started.promise
  await Bun.sleep(40)
  expect(calls).toBe(1)
  stop()
  response.resolve("busy")
  await Bun.sleep(40)
  expect(calls).toBe(1)
  expect(statuses).toEqual([])
})

test("a status failure is reported without fabricating idle and polling recovers", async () => {
  const failure = new Error("offline")
  const recovered = Promise.withResolvers<void>()
  const statuses: string[] = []
  const errors: unknown[] = []
  let calls = 0
  const stop = watchSessionStatus({
    interval: 10,
    read: async () => {
      if (++calls === 1) throw failure
      return "busy"
    },
    onStatus: (status) => {
      statuses.push(status)
      recovered.resolve()
    },
    onError: (error) => errors.push(error),
  })
  try {
    await recovered.promise
    expect(errors).toEqual([failure])
    expect(statuses).toEqual(["busy"])
  } finally {
    stop()
  }
})

test("normalizes a status to its phase", () => {
  expect(statusPhase(undefined)).toBeUndefined()
  expect(statusPhase({ type: "idle" })).toBeUndefined()
  expect(statusPhase({ type: "busy" })).toBe("preparing")
  expect(statusPhase({ type: "busy", phase: "queued" })).toBe("queued")
  expect(statusPhase({ type: "busy", phase: "requesting", since: 1 })).toBe("requesting")
  expect(statusPhase({ type: "retry", attempt: 1, message: "rate limited", next: 2 })).toBe("retrying")
})
