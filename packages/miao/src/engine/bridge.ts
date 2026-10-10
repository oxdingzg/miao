import { DateTime } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { SessionMessage } from "@miao/schema/session-message"
import { Prompt } from "@miao/schema/prompt"
import { Delivery } from "@miao/schema/session-delivery"
import { StatusInfo } from "@miao/schema/session-event"
import { adoptSession, messageID } from "./identity"
import type { EngineEvent } from "./client"

/**
 * The product `session.next.status` payload for one status transition. Status is
 * a live signal, never stored, so the bridge only carries what the shell needs to
 * render busy/idle for a session.
 */
export type SessionStatus = {
  sessionID: SessionID
  timestamp: DateTime.Utc
  status: StatusInfo
}

/** The status an engine lifecycle event implies, or `undefined` when it carries none. */
export function statusOf(event: EngineEvent): StatusInfo | undefined {
  switch (event.kind) {
    case "run.started":
      return { type: "busy" }
    case "run.finished":
      return { type: "idle" }
    case "provider.failed":
      return { type: "idle" }
    default:
      return undefined
  }
}

export function translateStatus(event: EngineEvent): SessionStatus | undefined {
  const status = statusOf(event)
  if (!status) return undefined
  return { sessionID: SessionID.descending(event.session_id), timestamp: DateTime.makeUnsafe(Date.now()), status }
}

/**
 * Emits a product status payload only when the session's status actually changes,
 * so a burst of engine events (or a resubscribe) does not republish `busy`.
 */
export class StatusBridge {
  #current: StatusInfo["type"] | undefined

  update(event: EngineEvent): SessionStatus | undefined {
    const status = statusOf(event)
    if (!status || status.type === this.#current) return undefined
    this.#current = status.type
    return { sessionID: SessionID.descending(event.session_id), timestamp: DateTime.makeUnsafe(Date.now()), status }
  }
}

/** The product `session.next.prompt.admitted` payload for a promoted input. */
export type SessionPromptAdmitted = {
  sessionID: SessionID
  timestamp: DateTime.Utc
  messageID: SessionMessage.ID
  prompt: Prompt
  delivery: Delivery
}

/**
 * Maps the engine's `input.promoted` event to `session.next.prompt.admitted`,
 * making the admitted user message visible on the shell. The engine delivers
 * promotions as `steer` by default; a `queue` delivery would ride the same event
 * once the engine surfaces the mode.
 */
export function translatePrompt(event: EngineEvent): SessionPromptAdmitted | undefined {
  if (event.kind !== "input.promoted") return undefined
  if (typeof event.data !== "object" || event.data === null || !("prompt" in event.data)) return undefined
  const text = event.data.prompt
  if (typeof text !== "string") return undefined
  return {
    sessionID: adoptSession(event.session_id),
    timestamp: DateTime.makeUnsafe(Date.now()),
    messageID: messageID(event.session_id, event.seq),
    prompt: { text },
    delivery: "steer",
  }
}

/** The product `session.next.text.ended` payload for one committed assistant text block. */
export type SessionTextEnded = {
  sessionID: SessionID
  timestamp: DateTime.Utc
  assistantMessageID: SessionMessage.ID
  textID: string
  text: string
}

/**
 * Maps a committed assistant message to the product `session.next.text.ended`
 * events for its text blocks. `text.ended` is the replayable boundary (the
 * `text.delta` fragments are live-only), so a replayed commit reproduces the
 * same full-value events. Non-text blocks (tool_use, reasoning) are later slices.
 */
export function translateMessage(event: EngineEvent): SessionTextEnded[] {
  if (event.kind !== "message.committed") return []
  if (typeof event.data !== "object" || event.data === null) return []
  if (!("role" in event.data) || event.data.role !== "assistant") return []
  if (!("content" in event.data)) return []
  const content = event.data.content
  if (!Array.isArray(content)) return []
  const blocks: unknown[] = content
  const sessionID = adoptSession(event.session_id)
  const assistantMessageID = messageID(event.session_id, event.seq)
  return blocks.flatMap((block, index) => {
    if (typeof block !== "object" || block === null) return []
    if (!("type" in block) || block.type !== "text") return []
    if (!("text" in block) || typeof block.text !== "string") return []
    return [
      {
        sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        assistantMessageID,
        textID: `text_${event.seq}_${index}`,
        text: block.text,
      },
    ]
  })
}

const TOOL_IDS: Record<string, string> = {
  read_file: "read",
  list_files: "read",
  glob: "glob",
  grep: "grep",
  write_file: "write",
  edit_file: "edit",
  apply_patch: "apply-patch",
  run_command: "bash",
  bash: "bash",
  start_job: "background-job",
  job_status: "background-job",
  cancel_job: "background-job",
  task: "task",
  todowrite: "todowrite",
  goal: "goal",
  question: "question",
  recall: "recall",
  session_state: "custom",
  schedule_wakeup: "schedule",
  cancel_wakeup: "schedule",
  lsp_diagnostics: "lsp",
  lsp_definition: "lsp",
  lsp_references: "lsp",
}

/**
 * Map an engine tool name to the product tool id whose renderer already exists
 * (`facade-mapping.md`). Unknown, worker and MCP tools fall back to `custom`.
 */
export function productToolID(engineTool: string): string {
  if (engineTool in TOOL_IDS) return TOOL_IDS[engineTool]
  if (engineTool.startsWith("cron_")) return "schedule"
  return "custom"
}

/** The product `session.next.tool.called` payload for one committed tool_use block. */
export type SessionToolCalled = {
  sessionID: SessionID
  timestamp: DateTime.Utc
  assistantMessageID: SessionMessage.ID
  callID: string
  tool: string
  input: Record<string, unknown>
  provider: { executed: boolean }
}

/**
 * Maps a committed assistant message to the product `session.next.tool.called`
 * events for its `tool_use` blocks. The engine executes tools itself, so
 * `provider.executed` is always false. Completion (`tool.success`/`tool.failed`)
 * is a later slice.
 */
export function translateTools(event: EngineEvent): SessionToolCalled[] {
  if (event.kind !== "message.committed") return []
  if (typeof event.data !== "object" || event.data === null) return []
  if (!("role" in event.data) || event.data.role !== "assistant") return []
  if (!("content" in event.data)) return []
  const content = event.data.content
  if (!Array.isArray(content)) return []
  const blocks: unknown[] = content
  const sessionID = adoptSession(event.session_id)
  const assistantMessageID = messageID(event.session_id, event.seq)
  return blocks.flatMap((block) => {
    if (typeof block !== "object" || block === null) return []
    if (!("type" in block) || block.type !== "tool_use") return []
    if (!("id" in block) || typeof block.id !== "string") return []
    if (!("name" in block) || typeof block.name !== "string") return []
    const input: Record<string, unknown> = {}
    if ("input" in block && typeof block.input === "object" && block.input !== null) {
      for (const key of Object.keys(block.input)) input[key] = Reflect.get(block.input, key)
    }
    return [
      {
        sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        assistantMessageID,
        callID: block.id,
        tool: productToolID(block.name),
        input,
        provider: { executed: false },
      },
    ]
  })
}

/** The product `session.next.tool.success` payload for one completed engine tool. */
export type SessionToolSuccess = {
  type: "session.next.tool.success"
  sessionID: SessionID
  timestamp: DateTime.Utc
  assistantMessageID: SessionMessage.ID
  callID: string
  structured: Record<string, unknown>
  content: { type: "text"; text: string }[]
  provider: { executed: boolean }
}

/** The product `session.next.tool.failed` payload for one failed engine tool. */
export type SessionToolFailed = {
  type: "session.next.tool.failed"
  sessionID: SessionID
  timestamp: DateTime.Utc
  assistantMessageID: SessionMessage.ID
  callID: string
  error: { type: "unknown"; message: string }
  provider: { executed: boolean }
}

export type SessionToolResult = SessionToolSuccess | SessionToolFailed

/**
 * Correlates committed tool calls with their engine completions. The engine's
 * `tool.completed` carries only `call_id`, while the product `tool.success`/
 * `tool.failed` also needs the `assistantMessageID`; `note` records that from the
 * committed assistant projection, then `result` maps the completion.
 */
export class ToolBridge {
  #calls = new Map<string, { sessionID: SessionID; assistantMessageID: SessionMessage.ID }>()

  /** Record `callID -> assistantMessageID` from a committed assistant message. */
  note(event: EngineEvent): void {
    if (event.kind !== "message.committed") return
    if (typeof event.data !== "object" || event.data === null) return
    if (!("role" in event.data) || event.data.role !== "assistant") return
    if (!("content" in event.data) || !Array.isArray(event.data.content)) return
    const blocks: unknown[] = event.data.content
    const sessionID = adoptSession(event.session_id)
    const assistantMessageID = messageID(event.session_id, event.seq)
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue
      if (!("type" in block) || block.type !== "tool_use") continue
      if (!("id" in block) || typeof block.id !== "string") continue
      this.#calls.set(block.id, { sessionID, assistantMessageID })
    }
  }

  /** Map a `tool.completed` event to a product tool result, when its call is known. */
  result(event: EngineEvent): SessionToolResult | undefined {
    if (event.kind !== "tool.completed") return undefined
    if (typeof event.data !== "object" || event.data === null) return undefined
    if (!("call_id" in event.data) || typeof event.data.call_id !== "string") return undefined
    const known = this.#calls.get(event.data.call_id)
    if (!known) return undefined
    const raw: unknown = "result" in event.data ? Reflect.get(event.data, "result") : undefined
    const output = typeof raw === "string" ? raw : JSON.stringify(raw ?? null)
    const base = {
      sessionID: known.sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: known.assistantMessageID,
      callID: event.data.call_id,
      provider: { executed: false },
    }
    if ("is_error" in event.data && event.data.is_error === true) {
      return { type: "session.next.tool.failed", ...base, error: { type: "unknown", message: output } }
    }
    return { type: "session.next.tool.success", ...base, structured: {}, content: [{ type: "text", text: output }] }
  }
}
