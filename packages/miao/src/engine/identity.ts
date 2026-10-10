import { SessionID } from "@miao/schema/session-id"
import { SessionMessage } from "@miao/schema/session-message"

/**
 * Identity synthesis for the B1 façade: the engine owns `session_id`/`run_id`/
 * `call_id` (`ses_*` / opaque), while product events carry branded
 * `SessionID`/`SessionMessage.ID`. These helpers map one to the other
 * deterministically so a replayed or re-derived event keeps the same identity.
 *
 * Tool `callID` fields are plain strings on the product side, so an engine
 * `call_id`/`provider_id` passes through without synthesis.
 */

/** Adopt the engine session id as the product session id (1:1). */
export function adoptSession(engineSessionID: string): SessionID {
  return SessionID.descending(engineSessionID)
}

/** Deterministic product message id from the engine session and the committed seq. */
export function messageID(engineSessionID: string, seq: number): SessionMessage.ID {
  return SessionMessage.ID.make(`msg_${engineSessionID}_${seq}`)
}
