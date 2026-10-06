import type { SessionMessage, SessionMessageAssistantTool } from "@miao/schema/view-models"
import type { TuiTranscriptMessage } from "@miao/plugin/tui"

/**
 * A V2 durable session event that changes the transcript and therefore needs a
 * re-hydration. Location moves and status heartbeats do not change messages;
 * the sync owner handles idle transitions separately.
 */
export function isLiveSessionV2Event(type: string): boolean {
  return (
    type.startsWith("session.next.") &&
    type !== "session.next.moved" &&
    type !== "session.next.status" &&
    type !== "session.next.retried"
  )
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
 * A live V2 event that changes the session list (a new session, or a renamed
 * one) without changing any transcript. A TUI refreshes its list for these even
 * when it has not opened the session, but must not hydrate a transcript from
 * them.
 */
export function isSessionListV2Event(type: string): boolean {
  return type === "session.next.created" || type === "session.next.info.updated"
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
export type OlderHistory = { messages: SessionMessage[]; cursor?: string }

/**
 * The text a settled tool run produced. V2 tool state keeps output in `content`
 * (text items) rather than a single `output` string the way V1 did.
 */
export function toolOutputText(state: SessionMessageAssistantTool["state"]): string {
  if (state.status !== "completed" && state.status !== "error") return ""
  return state.content
    .map((item: { type: string; text?: string }) => (item.type === "text" ? item.text : ""))
    .join("")
}

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
