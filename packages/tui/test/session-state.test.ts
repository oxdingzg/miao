import { expect, test } from "bun:test"
import type { SessionsActivityOutput } from "@miao/client"
import type { TranscriptAssistantMessage } from "@miao/schema/view-models"
import { sessionState, todoSummary } from "../src/util/session-state"

const activity: SessionsActivityOutput = {
  observedAt: 1000,
  status: { type: "idle" },
  pendingNotifications: 0,
  schedules: [],
  jobs: [],
}
const message: TranscriptAssistantMessage = {
  id: "msg_final",
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "test" },
  content: [],
  finish: "stop",
  time: { created: 100, completed: 200 },
}
const input = { status: { type: "idle" as const }, blocked: false, todos: [], activity, message }

test("idle execution cannot declare unfinished todos completed", () => {
  expect(sessionState({ ...input, todos: [{ status: "in_progress" }] })).toBe("incomplete")
  expect(sessionState({ ...input, todos: [{ status: "pending" }] })).toBe("incomplete")
  expect(sessionState({ ...input, todos: [{ status: "completed" }, { status: "cancelled" }] })).toBe("completed")
  expect(todoSummary([{ status: "completed" }, { status: "cancelled" }, { status: "in_progress" }])).toEqual({
    total: 3,
    completed: 1,
    cancelled: 1,
    remaining: 1,
  })
})

test("completed checklist still waits for a successful final response", () => {
  expect(
    sessionState({ ...input, message: { ...message, finish: "tool-calls" }, todos: [{ status: "completed" }] }),
  ).toBe("incomplete")
  expect(sessionState({ ...input, message: { ...message, time: { created: 100 } } })).toBe("incomplete")
  expect(sessionState({ ...input, message: undefined })).toBe("idle")
})

test("live waits take precedence over completed todos or a previous final answer", () => {
  expect(sessionState({ ...input, pendingInputs: true })).toBe("waiting")
  expect(sessionState({ ...input, activity: { ...activity, pendingNotifications: 1 } })).toBe("waiting")
  expect(
    sessionState({
      ...input,
      activity: {
        ...activity,
        schedules: [{ id: "wake", prompt: "resume", createdAt: 1, nextAt: 2000, recurring: false }],
      },
    }),
  ).toBe("waiting")
  expect(
    sessionState({ ...input, activity: { ...activity, jobs: [{ id: "job", status: "running", startedAt: 1 }] } }),
  ).toBe("waiting")
})

test("execution and decisions outrank checklist outcome; lost observations cannot show success", () => {
  expect(sessionState({ ...input, status: { type: "busy" } })).toBe("processing")
  expect(sessionState({ ...input, blocked: true, status: { type: "busy" } })).toBe("awaiting")
  expect(sessionState({ ...input, error: "failed" })).toBe("error")
  expect(sessionState({ ...input, unavailable: true })).toBe("unknown")
  expect(sessionState({ ...input, activity: undefined })).toBe("unknown")
  expect(
    sessionState({ ...input, activity: { ...activity, jobs: [{ id: "lost", status: "error", startedAt: 1 }] } }),
  ).toBe("unknown")
})
