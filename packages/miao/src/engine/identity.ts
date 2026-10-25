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

/**
 * Product identity for an input the engine generated itself.
 *
 * A product prompt keeps the identity it was submitted with, so an exact retry
 * and a later cancel can address it. Monitor notices, cron and wakeup fires and
 * job receipts have no product identity of their own, but the engine's durable
 * input id is the fact the journal admits, promotes, cancels and replays. The
 * inbox receipt, the promotion event and the cancel path therefore all derive
 * one product id from that id instead of inventing a second, seq-shaped one
 * that only the reader knows. The engine id stays reversible so a cancel can
 * address the row the engine actually stores.
 */
export function generatedInputMessageID(engineInputID: string): SessionMessage.ID {
  return SessionMessage.ID.make(`msg_gen_${Buffer.from(engineInputID, "utf8").toString("base64url")}`)
}

/** The engine input id behind a generated product identity, when it is one. */
export function generatedInputEngineID(messageID: string): string | undefined {
  const match = /^msg_gen_([A-Za-z0-9_-]+)$/.exec(messageID)
  if (match === null) return undefined
  const engineInputID = Buffer.from(match[1]!, "base64url").toString("utf8")
  // Reject non-canonical encodings so only ids this module produced round-trip
  // into an engine cancel. An empty or mangled payload is not an identity.
  if (engineInputID.length === 0 || generatedInputMessageID(engineInputID) !== messageID) return undefined
  return engineInputID
}

/** The promoted input's product identity: submitted ids keep theirs, generated ones derive from the engine id. */
export function promotedInputMessageID(engineInputID: string): SessionMessage.ID {
  return engineInputID.startsWith("msg_")
    ? SessionMessage.ID.make(engineInputID)
    : generatedInputMessageID(engineInputID)
}
