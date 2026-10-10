import { DateTime } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { StatusInfo } from "@miao/schema/session-event"
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
