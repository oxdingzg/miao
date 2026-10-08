// The Stage 2 timeline renders part content from the V2 session_message
// records, but legacy servers and the V1 event oracles still stream
// `message.part.*` updates. The V1 handler keeps the projected `data.part`
// store in sync; these helpers mirror each change into the records so the
// record-driven renderer sees the same content. They mirror the tool-state
// shapes the V2 reducer writes (see server-session-v2-reducer.ts).
import type { Part } from "@miao/schema/view-models"
import type { SessionMessageInfo } from "@/utils/server"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Content = Assistant["content"][number]

function toolState(part: Extract<Part, { type: "tool" }>): Content {
  const state = part.state
  const started = "time" in state ? state.time?.start : undefined
  const ended = "time" in state && "end" in state.time ? state.time.end : undefined
  const time = {
    created: started ?? 0,
    ran: state.status === "pending" ? undefined : started,
    completed: state.status === "pending" || state.status === "running" ? undefined : ended,
  }
  if (state.status === "pending")
    return { type: "tool", id: part.id, name: part.tool, time, state: { status: "pending", input: JSON.stringify(state.input ?? {}) } }
  if (state.status === "running")
    return {
      type: "tool",
      id: part.id,
      name: part.tool,
      time,
      state: { status: "running", input: state.input ?? {}, structured: state.metadata ?? {}, content: [] },
    }
  if (state.status === "error")
    return {
      type: "tool",
      id: part.id,
      name: part.tool,
      time,
      state: {
        status: "error",
        input: state.input ?? {},
        structured: state.metadata ?? {},
        content: [],
        error: { type: "unknown", message: state.error ?? "Tool execution failed" },
      },
    }
  return {
    type: "tool",
    id: part.id,
    name: part.tool,
    time,
    state: {
      status: "completed",
      input: state.input ?? {},
      structured: state.metadata ?? {},
      content: [{ type: "text", text: state.output ?? "" }],
    },
  }
}

function legacyContent(part: Part): Content | undefined {
  if (part.type === "text") return { type: "text", id: part.id, text: part.text ?? "" }
  if (part.type === "reasoning")
    return {
      type: "reasoning",
      id: part.id,
      text: part.text ?? "",
      providerMetadata: part.metadata,
      time: { created: part.time?.start ?? 0, completed: part.time?.end },
    }
  if (part.type === "tool") return toolState(part)
  return undefined
}

/** Project a legacy message's parts into the record content shapes at load time. */
export function legacyContents(parts: Part[]): Content[] {
  return parts.flatMap((part) => {
    const content = legacyContent(part)
    return content ? [content] : []
  })
}

/** Merge one legacy `message.part.updated` part into the session_message records. */
export function mergeLegacyPart(records: SessionMessageInfo[], part: Part): SessionMessageInfo[] {
  // The store passes undefined for a session whose records were never written;
  // returning it unchanged keeps the key unset (same contract as `messages?.filter`).
  if (!records) return records as SessionMessageInfo[]
  const index = records.findIndex((message) => message.id === part.messageID)
  const message = records[index]
  if (!message || message.type !== "assistant") return records
  const content = legacyContent(part)
  if (!content) return records
  const existing = message.content.findIndex((item) => item.id === part.id)
  const next =
    existing >= 0 ? message.content.map((item, at) => (at === existing ? content : item)) : [...message.content, content]
  const patched: Assistant = { ...message, content: next }
  return records.map((item, at) => (at === index ? patched : item))
}

/** Remove one legacy part from the session_message records. */
export function removeLegacyPart(records: SessionMessageInfo[], messageID: string, partID: string): SessionMessageInfo[] {
  // The store passes undefined for a session whose records were never written;
  // returning it unchanged keeps the key unset (same contract as `messages?.filter`).
  if (!records) return records as SessionMessageInfo[]
  const index = records.findIndex((message) => message.id === messageID)
  const message = records[index]
  if (!message || message.type !== "assistant") return records
  if (!message.content.some((item) => item.id === partID)) return records
  const patched: Assistant = { ...message, content: message.content.filter((item) => item.id !== partID) }
  return records.map((item, at) => (at === index ? patched : item))
}

/** Apply a legacy `message.part.delta` to the record's text or reasoning content. */
export function mergeLegacyDelta(
  records: SessionMessageInfo[],
  messageID: string,
  partID: string,
  field: string,
  delta: string,
): SessionMessageInfo[] {
  // The store passes undefined for a session whose records were never written;
  // returning it unchanged keeps the key unset (same contract as `messages?.filter`).
  if (!records) return records as SessionMessageInfo[]
  const index = records.findIndex((message) => message.id === messageID)
  const message = records[index]
  if (!message || message.type !== "assistant") return records
  const type = field === "text" ? "text" : field === "thinking" ? "reasoning" : undefined
  if (!type) return records
  const existing = message.content.find((item) => item.id === partID)
  if (existing && existing.type !== type) return records
  const content = existing
    ? message.content.map((item) => (item.id === partID && "text" in item ? { ...item, text: item.text + delta } : item))
    : [
        ...message.content,
        type === "text"
          ? { type: "text" as const, id: partID, text: delta }
          : { type: "reasoning" as const, id: partID, text: delta, time: { created: 0 } },
      ]
  const patched: Assistant = { ...message, content }
  return records.map((item, at) => (at === index ? patched : item))
}
