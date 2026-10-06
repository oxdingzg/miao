import { expect, test } from "bun:test"
import { idlePollInterval, statusPhase, waitingForResponse, watchSessionStatus } from "../src/context/session-status"
import { testAssistantMessage, testUserMessage } from "./lib/v2-message"

const user = testUserMessage({ id: "msg_user", text: "hello", created: 1 })
const assistant = testAssistantMessage({ id: "msg_assistant", agent: "build", model: { id: "test", providerID: "test" }, created: 2 })

test("busy execution is visible before the assistant or its first readable frame exists", () => {
  expect(waitingForResponse({ busy: true, blocked: false, content: [] })).toBe(true)
  expect(waitingForResponse({ busy: true, blocked: false, message: user, content: [] })).toBe(true)
  expect(waitingForResponse({ busy: true, blocked: false, message: assistant, content: [] })).toBe(true)
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistant,
      content: [{ type: "reasoning", id: "part", text: "" }],
    }),
  ).toBe(true)
})

test("idle, interrupted and blocked execution do not show a false provider wait", () => {
  expect(waitingForResponse({ busy: false, blocked: false, message: user, content: [] })).toBe(false)
  expect(waitingForResponse({ busy: true, blocked: true, message: user, content: [] })).toBe(false)
  expect(
    waitingForResponse({
      busy: false,
      blocked: false,
      message: { ...assistant, time: { created: 2, completed: 3 } },
      content: [],
    }),
  ).toBe(false)
})

test("readable text, reasoning or tool progress replaces the initial waiting indicator", () => {
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistant,
      content: [{ type: "text", id: "part", text: "hello" }],
    }),
  ).toBe(false)
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistant,
      content: [{ type: "reasoning", id: "part", text: "thinking", time: { created: 2 } }],
    }),
  ).toBe(false)
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: assistant,
      content: [{ type: "tool", id: "call", name: "bash", time: { created: 2 } }] as never,
    }),
  ).toBe(false)
})

test("an active continuation shows waiting again after the previous step finishes", () => {
  expect(
    waitingForResponse({
      busy: true,
      blocked: false,
      message: { ...assistant, time: { created: 2, completed: 3 }, finish: "tool-calls" },
      content: [{ type: "text", id: "part", text: "previous step" }],
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

test("idle polls back off while the streak grows and reset on any change", () => {
  expect(idlePollInterval(5000, 0)).toBe(5000)
  expect(idlePollInterval(5000, 1)).toBe(10000)
  expect(idlePollInterval(5000, 2)).toBe(20000)
  expect(idlePollInterval(5000, 3)).toBe(30000)
  expect(idlePollInterval(5000, 99)).toBe(30000)
  // The cap scales with the cadence; a change resets the streak in the poll
  // loop, so streak 0 is the close cadence again.
  expect(idlePollInterval(1000, 99)).toBe(6000)
  expect(idlePollInterval(1000, 0)).toBe(1000)
})
