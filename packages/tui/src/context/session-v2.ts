import type { Part, SessionMessage } from "@opencode-ai/sdk/v2"
import type { TuiTranscriptMessage } from "@opencode-ai/plugin/tui"

/**
 * A V2 durable session event that changes the transcript and therefore needs a
 * re-hydration. Location moves (`session.next.moved`) do not change messages.
 */
export function isLiveSessionV2Event(type: string): boolean {
  return type.startsWith("session.next.") && type !== "session.next.moved"
}

/**
 * Live-only stream fragments. These arrive per token, so re-hydrating the whole
 * transcript for each one is what made long V2 sessions burn CPU. Text and
 * reasoning fragments are applied incrementally; tool input/progress fragments
 * are dropped because the TUI only renders a running tool once it settles. The
 * matching durable `*.ended`/`tool.success` event is the boundary that
 * re-hydrates and reconciles the final value.
 */
export function isV2StreamFragmentEvent(type: string): boolean {
  return (
    type === "session.next.text.delta" ||
    type === "session.next.reasoning.delta" ||
    type === "session.next.tool.input.delta" ||
    type === "session.next.tool.progress"
  )
}

/**
 * Maps the V2 session context transcript (`/api/session/:id/context`) into the
 * V1 `Message` + `Part` shape the TUI already renders. This is the read half of
 * the TUI V2 cutover (`specs/v2/tui-read-cutover.md`); writes stay on V1 for now.
 *
 * Only user and assistant messages appear in the transcript; V2 meta messages
 * (agent-switched, model-switched, synthetic, system, shell, compaction) carry
 * no V1 equivalent and are skipped.
 */
export function sessionContextToMessages(input: {
  sessionID: string
  cwd: string
  root: string
  messages: SessionMessage[]
}): { info: TuiTranscriptMessage; parts: Part[] }[] {
  const result: { info: TuiTranscriptMessage; parts: Part[] }[] = []
  let lastAgent = ""
  let lastModel: { providerID: string; modelID: string; variant?: string } = { providerID: "", modelID: "" }
  let lastUserID = ""
  for (const message of input.messages) {
    if (message.type === "agent-switched") {
      lastAgent = message.agent
      continue
    }
    if (message.type === "model-switched") {
      lastModel = { providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant }
      continue
    }
    if (message.type === "user") {
      lastUserID = message.id
      result.push({
        info: {
          id: message.id,
          sessionID: input.sessionID,
          role: "user",
          time: { created: message.time.created },
          agent: lastAgent,
          model: lastModel,
        },
        parts: userParts(input.sessionID, message),
      })
      continue
    }
    if (message.type === "assistant") {
      result.push({
        info: {
          id: message.id,
          sessionID: input.sessionID,
          role: "assistant",
          time: { created: message.time.created, completed: message.time.completed },
          parentID: lastUserID,
          modelID: message.model.id,
          providerID: message.model.providerID,
          variant: message.model.variant,
          mode: message.agent,
          agent: message.agent,
          path: { cwd: input.cwd, root: input.root },
          cost: message.cost ?? 0,
          tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ttft: message.ttft,
          finish: message.finish,
          error: message.error ? { name: "UnknownError", data: { message: message.error.message } } : undefined,
        },
        parts: message.content.map((content) => {
          if (content.type === "text") {
            return {
              id: content.id,
              sessionID: input.sessionID,
              messageID: message.id,
              type: "text",
              text: content.text,
            }
          }
          if (content.type === "reasoning") {
            return {
              id: content.id,
              sessionID: input.sessionID,
              messageID: message.id,
              type: "reasoning",
              text: content.text,
              time: { start: content.time?.created ?? message.time.created, end: content.time?.completed },
            }
          }
          return toolPart(input.sessionID, message.id, content)
        }),
      })
    }
  }
  return result
}

/**
 * Timeline pages already pulled in behind the active window, oldest last. V2
 * pages a `desc` (newest first) timeline with `cursor.next` walking back in
 * time, so `cursor` is the anchor for the next older page.
 */
export type OlderHistory = { messages: SessionMessage[]; cursor?: string }

/**
 * The transcript must reach back past compaction the way V1 did. `context` is
 * the model-visible window (everything after the last compaction) and carries
 * unpruned tool detail, while the paginated `messages` pages also include the
 * compacted timeline. Keep the active window's richer copy for ids it owns and
 * append the older projected history in timeline order.
 */
export function mergeTranscript(
  active: readonly SessionMessage[],
  history: readonly SessionMessage[],
): SessionMessage[] {
  const seen = new Set(active.map((message) => message.id))
  const older: SessionMessage[] = []
  for (const message of history) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    older.push(message)
  }
  return [...older, ...active].toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
}

function userParts(sessionID: string, message: Extract<SessionMessage, { type: "user" }>): Part[] {
  const parts: Part[] = []
  if (message.text) {
    parts.push({ id: `${message.id}-text`, sessionID, messageID: message.id, type: "text", text: message.text })
  }
  for (const [index, file] of (message.files ?? []).entries()) {
    parts.push({
      id: `${message.id}-file-${index}`,
      sessionID,
      messageID: message.id,
      type: "file",
      mime: file.mime,
      filename: file.name,
      url: file.uri,
    })
  }
  return parts
}

/** Maps one projected V2 tool call into the V1 `ToolPart` shape the renderers read. */
export function toolPart(
  sessionID: string,
  messageID: string,
  tool: Extract<SessionMessage, { type: "assistant" }>["content"][number] & { type: "tool" },
): Part {
  const start = tool.time.ran ?? tool.time.created
  const end = tool.time.completed ?? start
  const state = tool.state
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state:
      state.status === "pending"
        ? { status: "pending", input: {}, raw: String(state.input) }
        : state.status === "running"
          ? { status: "running", input: toolInput(tool.name, state.input), time: { start } }
          : state.status === "completed"
            ? {
                status: "completed",
                input: toolInput(tool.name, state.input),
                output: textOf(state.content),
                title: tool.name,
                metadata: toolMetadata(tool.name, state.structured, textOf(state.content)),
                time: { start, end },
              }
            : {
                status: "error",
                input: toolInput(tool.name, state.input),
                error: state.error.message,
                metadata: toolMetadata(tool.name, state.structured),
                time: { start, end },
              },
  }
}

// V2 file tools name their target `path`; the shared TUI renderers read the V1
// `filePath`. Without this translation a completed file tool renders as a
// permanently pending row, which is why substantive blocks used to disappear.
const FILE_PATH_TOOLS = ["read", "write", "edit"]

function toolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!FILE_PATH_TOOLS.includes(name)) return input
  if (typeof input.path !== "string" || typeof input.filePath === "string") return input
  return { ...input, filePath: input.path }
}

// V2 tool state carries the tool's structured output separately from its text
// content. The TUI renderers read `metadata` (diffs, diagnostics, summaries) and
// `output` (body text), so merge them back into the V1 shape.
function toolMetadata(name: string, structured: unknown, output?: string): Record<string, unknown> {
  const metadata = structuredMetadata(structured)
  const diff = name === "edit" ? editsToDiff(metadata.files) : undefined
  if (diff && metadata.diff === undefined) metadata.diff = diff
  if (name === "apply_patch" && Array.isArray(metadata.files)) metadata.files = patchFileEntries(metadata.files)
  if (name === "task" && typeof metadata.sessionID === "string") metadata.sessionId = metadata.sessionID
  if (output === undefined) return metadata
  return { ...metadata, output }
}

// V2 `edit` reports `FileDiff.Info` entries while the TUI renders one V1
// `metadata.diff` string, so join the patches back into a single block.
function editsToDiff(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const patches = value.flatMap((file) => {
    if (typeof file !== "object" || file === null) return []
    const patch = (file as { patch?: unknown }).patch
    return typeof patch === "string" && patch.length > 0 ? [patch] : []
  })
  return patches.length > 0 ? patches.join("\n") : undefined
}

// The patch block renderer reads the legacy `type`/`relativePath`/`filePath`
// shape, not `FileDiff.Info`.
function patchFileEntries(files: ReadonlyArray<unknown>): Record<string, unknown>[] {
  return files.flatMap((file) => {
    if (typeof file !== "object" || file === null) return []
    const entry = file as { file?: unknown; patch?: unknown; deletions?: unknown; status?: unknown }
    if (typeof entry.file !== "string") return []
    return [
      {
        type: entry.status === "added" ? "add" : entry.status === "deleted" ? "delete" : "update",
        relativePath: entry.file,
        filePath: entry.file,
        patch: entry.patch,
        deletions: typeof entry.deletions === "number" ? entry.deletions : 0,
      },
    ]
  })
}

function structuredMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function textOf(content: Array<{ type: string; text?: string }>) {
  return content.flatMap((item) => (item.type === "text" ? [item.text ?? ""] : [])).join("\n")
}
