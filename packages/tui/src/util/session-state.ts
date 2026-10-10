import type { SessionsActivityOutput } from "@miao/client"
import type { SessionMessage, SessionStatus, Todo } from "@miao/schema/view-models"

export type SessionState =
  | "idle"
  | "processing"
  | "awaiting"
  | "waiting"
  | "incomplete"
  | "completed"
  | "error"
  | "unknown"

export function todoSummary(todos: ReadonlyArray<Pick<Todo, "status">>) {
  return {
    total: todos.length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    cancelled: todos.filter((todo) => todo.status === "cancelled").length,
    remaining: todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length,
  }
}

/** Execution, live waits and task outcome are separate facts; idle is not success. */
export function sessionState(input: {
  status?: SessionStatus
  blocked: boolean
  error?: string
  todos: ReadonlyArray<Pick<Todo, "status">>
  message?: SessionMessage
  activity?: SessionsActivityOutput
  pendingInputs?: boolean
  unavailable?: boolean
}): SessionState {
  if (input.unavailable) return "unknown"
  if (input.blocked) return "awaiting"
  if (input.status && input.status.type !== "idle") return "processing"
  if (input.error || (input.message?.type === "assistant" && input.message.error)) return "error"
  if (!input.status || !input.activity) return "unknown"
  if (
    input.pendingInputs ||
    input.activity.pendingNotifications > 0 ||
    input.activity.schedules.length > 0 ||
    input.activity.jobs.some((job) => job.status === "running")
  )
    return "waiting"
  if (input.activity.jobs.some((job) => job.status === "error" && job.completedAt === undefined)) return "unknown"
  if (todoSummary(input.todos).remaining > 0) return "incomplete"
  // A stopped/interrupted/tool-only turn has no successful final response.
  // Completed todos alone cannot declare the whole Session successful.
  if (
    input.message?.type === "assistant" &&
    input.message.time.completed !== undefined &&
    input.message.finish === "stop"
  )
    return "completed"
  return input.message ? "incomplete" : "idle"
}

export const sessionStateLabel: Record<SessionState, string> = {
  idle: "Idle",
  processing: "Working",
  awaiting: "Waiting for you",
  waiting: "Waiting for background work",
  incomplete: "Paused · unfinished",
  completed: "Completed",
  error: "Failed",
  unknown: "Status unavailable",
}
