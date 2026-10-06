// V2 session reads for `miao --mini`.
//
// The reducers and renderers in run/* still speak the V1 `Message` + `Part`
// vocabulary, so this module turns the V2 projected transcript into that shape
// (through the TUI's shared `sessionContextToMessages`) and maps V2 blocker
// requests onto the V1 request shape the footer views render.
//
// Part ids are scoped by message: V2 text and reasoning ids come from the
// provider stream and restart every turn ("text-0"), and some providers number
// tool calls the same way. The reducers dedupe by part id across the whole
// session, so every id the reducers see is `${messageID}:${id}`, both on replay
// and for live events.
import type {
  LlmToolContent,
  Part,
  PermissionRequest,
  PermissionV2Request,
  QuestionRequest,
  QuestionV2Request,
  SessionMessage,
  SessionMessageAssistantTool,
  ToolPart,
} from "@miao/schema/view-models"
import { type Client } from "@/client"
import { mutableResponse } from "@miao/tui/util/mutable-response"
import { mergeTranscript, sessionContextToMessages, toolPart } from "@miao/tui/context/session-v2-write"
import type { SessionMessages } from "./session.shared"

// The messages route caps one page; larger replays walk the timeline.
const PAGE_LIMIT = 200

export type TranscriptEntry =
  | { type: "message"; message: SessionMessages[number] }
  | { type: "shell"; id: string; callID: string; command: string; output: string; completed: boolean }
  | { type: "compaction"; id: string; reason: "auto" | "manual" }

// V2 interruption settles the open step with this message. Like V1's
// MessageAbortedError it ends the turn without an error row.
export const INTERRUPTED_STEP = "Provider turn interrupted"

export function partKey(messageID: string, id: string) {
  return `${messageID}:${id}`
}

/**
 * Reads the session transcript the way the TUI does: the model-visible context
 * (everything after the last compaction, with unpruned tool detail) merged with
 * the projected timeline so history before a compaction stays visible. Without
 * a limit the whole timeline is read; with one, only enough newest pages to
 * cover it.
 */
export async function loadTranscript(sdk: Client, sessionID: string, limit?: number) {
  const [context, history] = await Promise.all([
    sdk.sessions.context({ sessionID }).then(mutableResponse),
    timeline(sdk, sessionID, limit),
  ])
  return mergeTranscript(context, history)
}

async function timeline(sdk: Client, sessionID: string, limit: number | undefined) {
  const pages: SessionMessage[] = []
  const read = async (cursor: string | undefined): Promise<SessionMessage[]> => {
    // A cursor carries its page order; the route refuses it alongside `order`.
    const page = await sdk.messages.list(
      cursor ? { sessionID, limit: PAGE_LIMIT, cursor } : { sessionID, order: "desc", limit: PAGE_LIMIT },
      {},
    )
    pages.push(...mutableResponse(page.data))
    const next = page.cursor.next
    if (!next || page.data.length === 0) return pages
    if (limit !== undefined && pages.length >= limit) return pages
    return read(next)
  }
  return read(undefined)
}

/**
 * Maps a projected V2 transcript into ordered replay entries. User and
 * assistant messages become V1-shaped messages; direct shell runs and
 * compactions, which have no V1 message equivalent, keep their own entries.
 */
export function transcriptEntries(input: {
  sessionID: string
  directory: string
  messages: SessionMessage[]
}): TranscriptEntry[] {
  const mapped = new Map(
    sessionContextToMessages({
      sessionID: input.sessionID,
      cwd: input.directory,
      root: input.directory,
      messages: input.messages.map(trimToolStatus),
    }).map((message) => [message.info.id, message]),
  )
  return input.messages.flatMap((message): TranscriptEntry[] => {
    if (message.type === "shell") {
      return [
        {
          type: "shell",
          id: message.id,
          callID: message.callID,
          command: message.command,
          output: message.output,
          completed: message.time.completed !== undefined,
        },
      ]
    }
    if (message.type === "compaction") return [{ type: "compaction", id: message.id, reason: message.reason }]
    const found = mapped.get(message.id)
    if (!found) return []
    const completed = message.type === "assistant" ? message.time.completed : undefined
    return [
      {
        type: "message",
        message: {
          info: interruptedAsAborted(found.info),
          parts: found.parts.map((part) => settleText(scopePart(part), message.time.created, completed)),
        },
      },
    ]
  })
}

function interruptedAsAborted(info: SessionMessages[number]["info"]): SessionMessages[number]["info"] {
  if (info.role !== "assistant" || info.error?.name !== "UnknownError") return info
  if (info.error.data.message !== INTERRUPTED_STEP) return info
  return { ...info, error: { name: "MessageAbortedError", data: { message: INTERRUPTED_STEP } } }
}

// Only `text.ended`/`reasoning.ended` are durable (deltas are live-only), so a
// projected text or reasoning item is either still empty because it is
// streaming, or final. Backfilled legacy items carry no times at all. The
// reducer needs the end marker to stop treating the part as active.
function settleText(part: Part, created: number, completed: number | undefined): Part {
  if (part.type !== "text" && part.type !== "reasoning") return part
  if (part.time?.end !== undefined) return part
  if (completed === undefined && part.text === "") return part
  const end = completed ?? part.time?.start ?? created
  return { ...part, time: { start: part.time?.start ?? end, end } }
}

/** The V1-shaped messages of a transcript, for prompt history and subagent bootstrap. */
export function transcriptMessages(input: {
  sessionID: string
  directory: string
  messages: SessionMessage[]
}): SessionMessages {
  return transcriptEntries(input).flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
}

/** Builds the V1 tool part for one live or projected V2 tool call, with a message-scoped id. */
export function liveToolPart(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const part = toolPart(sessionID, messageID, trimTool(tool))
  if (part.type !== "tool") throw new Error("tool content mapped to a non-tool part")
  return { ...part, id: partKey(messageID, part.id) }
}

function scopePart(part: Part): Part {
  if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool") return part
  // User parts already carry message-unique ids.
  if (part.id.startsWith(`${part.messageID}-`)) return part
  return { ...part, id: partKey(part.messageID, part.id) }
}

// V2 bash appends a model-facing status line ("[exit code 0]") after the
// command output; the exit code is already in the structured output, and V1
// showed only the output.
const BASH_STATUS = /(?:^|\n\n)\[(?:exit code -?\d+|command timed out)\]$/

function trimToolStatus(message: SessionMessage): SessionMessage {
  if (message.type !== "assistant") return message
  if (!message.content.some((item) => item.type === "tool" && item.name === "bash")) return message
  return {
    ...message,
    content: message.content.map((item) => (item.type === "tool" ? trimTool(item) : item)),
  }
}

function trimTool(tool: SessionMessageAssistantTool): SessionMessageAssistantTool {
  if (tool.name !== "bash") return tool
  const state = tool.state
  if (state.status !== "completed" && state.status !== "error") return tool
  // Legacy (backfilled) bash calls carry one content item: the output itself.
  if (state.content.length < 2) return tool
  return { ...tool, state: { ...state, content: trimStatus(state.content) } } as SessionMessageAssistantTool
}

function trimStatus(content: LlmToolContent[]): LlmToolContent[] {
  const last = content.at(-1)
  if (last?.type !== "text" || !BASH_STATUS.test(last.text)) return content
  const rest = last.text.replace(BASH_STATUS, "").trim()
  return rest ? [...content.slice(0, -1), { ...last, text: rest }] : content.slice(0, -1)
}

/** Maps a V2 permission ask onto the V1 request shape the permission view renders. */
export function permissionRequest(request: PermissionV2Request): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    metadata: request.metadata ?? {},
    always: request.save ?? [],
    ...(request.source?.type === "tool"
      ? { tool: { messageID: request.source.messageID, callID: request.source.callID } }
      : {}),
  }
}

/** V2 questions share the V1 request shape. */
export function questionRequest(request: QuestionV2Request): QuestionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    questions: request.questions,
    ...(request.tool ? { tool: request.tool } : {}),
  }
}
