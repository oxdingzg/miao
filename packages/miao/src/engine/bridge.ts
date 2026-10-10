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
