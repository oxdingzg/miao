// The last bridge of the V2-native transcript cutover (specs/v2/app-timeline-v2.md,
// stage 2): project V2 SessionMessage records into the V1 `Part` shapes that
// @miao/session-ui renders, contained inside the timeline model. The store-level
// projection this complements (`data.part` + normalizeSessionMessages) is
// retired in stage 3, leaving this module as the only content projection.
import type { FilePart, Part, ToolPart } from "@miao/schema/view-models"
import type { MessagesListOutput } from "@miao/client"

export type SessionMessageInfo = MessagesListOutput["data"][number]
export type SessionMessageUser = Extract<SessionMessageInfo, { type: "user" }>
export type SessionMessageShell = Extract<SessionMessageInfo, { type: "shell" }>
export type SessionMessageAssistant = Extract<SessionMessageInfo, { type: "assistant" }>
export type SessionMessageAssistantTool = Extract<SessionMessageAssistant["content"][number], { type: "tool" }>
import { Option, Schema } from "effect"
import { createComputed } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

const decodeToolInput = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Reactive per-session content projection: re-derives the parts whenever the
 * session's V2 records change and merges them through `reconcile` so unchanged
 * parts keep their references (streaming must not remount part components).
 */
export function createSessionContent(
  getSessionID: () => string | undefined,
  getRecords: (sessionID: string) => SessionMessageInfo[] | undefined,
) {
  const [parts, setParts] = createStore<Record<string, Part[]>>({})
  createComputed(() => {
    const sessionID = getSessionID()
    setParts(reconcile(sessionID ? contentParts(sessionID, getRecords(sessionID) ?? []) : {}, { key: "id" }))
  })
  return (messageID: string) => parts[messageID]
}

/**
 * Render parts for every message in the session, keyed by the message ID whose
 * turn displays them. Shell commands surface their output under
 * `${id}:assistant`, matching the user+assistant turn pair the V1 projection
 * built, and compaction markers attach to the turn-opening user message.
 */
export function contentParts(sessionID: string, source: readonly SessionMessageInfo[]): Record<string, Part[]> {
  const parts: Record<string, Part[]> = {}
  let parentID: string | undefined

  source.forEach((message) => {
    if (message.type === "user") {
      parentID = message.id
      parts[message.id] = userParts(sessionID, message)
      return
    }
    if (message.type === "synthetic" && message.text.trim()) {
      parentID = message.id
      parts[message.id] = [textPart(sessionID, message.id, 0, message.text, true)]
      return
    }
    if (message.type === "shell") {
      parts[message.id] = [textPart(sessionID, message.id, 0, message.command)]
      parts[`${message.id}:assistant`] = [shellPart(sessionID, message)]
      parentID = undefined
      return
    }
    if (message.type === "assistant") {
      parts[message.id] = assistantParts(sessionID, message)
      return
    }
    if (message.type !== "compaction" || !parentID) return
    parts[parentID] = [
      ...(parts[parentID] ?? []),
      {
        id: `${message.id}:compaction`,
        sessionID,
        messageID: parentID,
        type: "compaction",
        auto: message.reason === "auto",
      },
    ]
  })

  return parts
}

export function sessionMessagePartID(messageID: string, type: "text" | "reasoning", ordinal: number) {
  return `${messageID}:${type}:${ordinal}`
}

function userParts(sessionID: string, message: SessionMessageUser): Part[] {
  return [
    textPart(sessionID, message.id, 0, message.text),
    ...(message.files ?? []).map(
      (file, index): FilePart => ({
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
        source: file.source
          ? {
              type: "file",
              text: { value: file.source.text, start: file.source.start, end: file.source.end },
              path: file.source.text.startsWith("@") ? file.source.text.slice(1) : (file.name ?? file.source.text),
            }
          : undefined,
      }),
    ),
    ...(message.agents ?? []).map(
      (item, index): Part => ({
        id: `${message.id}:agent:${index}`,
        sessionID,
        messageID: message.id,
        type: "agent",
        name: item.name,
        source: item.source ? { value: item.source.text, start: item.source.start, end: item.source.end } : undefined,
      }),
    ),
  ]
}

function assistantParts(sessionID: string, message: SessionMessageAssistant): Part[] {
  const ordinals = { text: 0, reasoning: 0 }
  return message.content.flatMap((content): Part[] => {
    if (content.type === "text") {
      const part = textPart(sessionID, message.id, ordinals.text++, content.text)
      return content.text.trim() ? [part] : []
    }
    if (content.type === "reasoning") {
      const part: Part = {
        id: sessionMessagePartID(message.id, "reasoning", ordinals.reasoning++),
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: content.text,
        metadata: content.providerMetadata,
        time: {
          start: content.time?.created ?? message.time.created,
          end: content.time?.completed,
        },
      }
      return content.text.trim() ? [part] : []
    }
    return [toolPart(sessionID, message.id, content)]
  })
}

function textPart(sessionID: string, messageID: string, ordinal: number, text: string, synthetic?: boolean): Part {
  return {
    id: sessionMessagePartID(messageID, "text", ordinal),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic,
  }
}

function shellPart(sessionID: string, message: SessionMessageShell): ToolPart {
  const input = { command: message.command }
  const start = message.time.created
  const state: ToolPart["state"] =
    message.time.completed === undefined
      ? { status: "running", input, time: { start } }
      : {
          status: "completed",
          input,
          output: message.output,
          title: "Shell",
          metadata: {},
          time: { start, end: message.time.completed },
        }
  return {
    id: `${message.id}:tool`,
    sessionID,
    messageID: `${message.id}:assistant`,
    type: "tool",
    callID: message.callID,
    tool: "bash",
    state,
  }
}

function normalizeToolInput(name: string, input: Record<string, unknown>) {
  if (!["edit", "write"].includes(name) || typeof input.path !== "string" || typeof input.filePath === "string")
    return input
  return { ...input, filePath: input.path }
}

function normalizeToolMetadata(name: string, metadata: Record<string, unknown>) {
  if (name !== "edit" || !Array.isArray(metadata.files)) return metadata
  const file = metadata.files.find(record)
  if (!file || typeof file.file !== "string") return metadata
  return {
    ...metadata,
    filediff: {
      file: file.file,
      patch: typeof file.patch === "string" ? file.patch : undefined,
      additions: typeof file.additions === "number" ? file.additions : 0,
      deletions: typeof file.deletions === "number" ? file.deletions : 0,
    },
  }
}

function toolPart(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const start = tool.time.ran ?? tool.time.created
  const state = (() => {
    if (tool.state.status === "pending") {
      const value = Option.getOrUndefined(decodeToolInput(tool.state.input))
      const input = normalizeToolInput(tool.name, record(value) ? value : {})
      return { status: "pending" as const, input, raw: tool.state.input }
    }
    if (tool.state.status === "running") {
      return {
        status: "running" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        metadata: normalizeToolMetadata(tool.name, tool.state.structured),
        time: { start },
      }
    }
    if (tool.state.status === "error") {
      return {
        status: "error" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        error: tool.state.error.message,
        metadata: normalizeToolMetadata(tool.name, tool.state.structured),
        time: { start, end: tool.time.completed ?? start },
      }
    }
    const attachments = tool.state.content.flatMap((item, index): FilePart[] =>
      item.type === "file"
        ? [
            {
              id: `${tool.id}:file:${index}`,
              sessionID,
              messageID,
              type: "file",
              mime: item.mime,
              filename: item.name,
              url: item.uri,
            },
          ]
        : [],
    )
    return {
      status: "completed" as const,
      input: normalizeToolInput(tool.name, tool.state.input),
      output: tool.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
      title: tool.name,
      metadata: normalizeToolMetadata(tool.name, tool.state.structured),
      time: { start, end: tool.time.completed ?? start },
      attachments: attachments.length ? attachments : undefined,
    }
  })()
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: { providerState: tool.provider?.metadata, providerResultState: tool.provider?.resultMetadata },
  }
}
