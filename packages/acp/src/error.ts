import { RequestError } from "@agentclientprotocol/sdk"

/**
 * Converts whatever a handler threw into a JSON-RPC error. Declared server
 * errors arrive as their decoded JSON body (`{ _tag, message }`); anything else
 * is reported without internals.
 */
export function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error
  const tag = field(error, "_tag")
  const message = field(error, "message")
  if (tag === "SessionNotFoundError") {
    const sessionId = field(error, "sessionID")
    return RequestError.invalidParams({ sessionId }, `session not found: ${sessionId ?? "unknown"}`)
  }
  if (tag === "InvalidRequestError" || tag === "ConflictError") return RequestError.invalidParams({}, message)
  if (tag === "UnauthorizedError") return RequestError.authRequired({}, "miao server authentication failed")
  if (tag) return RequestError.internalError({ errorName: tag }, message ?? "miao service failure")
  return RequestError.internalError({}, "miao service failure")
}

export function sessionNotFound(sessionId: string) {
  return RequestError.invalidParams({ sessionId }, `session not found: ${sessionId}`)
}

function field(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) return undefined
  const result = (value as Record<string, unknown>)[key]
  return typeof result === "string" ? result : undefined
}
