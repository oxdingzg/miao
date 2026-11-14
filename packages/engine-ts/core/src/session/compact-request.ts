export * as SessionCompactRequest from "./compact-request"

/**
 * Process-local, one-shot requests to force a Session compaction on its next
 * provider-turn boundary. The runner consumes the request while assembling the
 * turn; the API sets it and starts a forced drain. This is not durable: a
 * crash between request and consumption drops it, which is acceptable for a
 * user-initiated compaction.
 */
const pending = new Set<string>()

export const request = (sessionID: string): void => {
  pending.add(sessionID)
}

export const consume = (sessionID: string): boolean => pending.delete(sessionID)

export const clear = (sessionID: string): void => {
  pending.delete(sessionID)
}
