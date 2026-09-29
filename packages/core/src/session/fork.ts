export * as SessionFork from "./fork"

/** Message-scoped identifier fields that must be remapped when forking a Session. */
const ID_KEYS = new Set(["messageID", "assistantMessageID", "callID", "textID", "reasoningID"])

/**
 * Deep-copies event data, rewriting every message-scoped identifier through
 * `next`. Used to replay a Session's history under a new aggregate without
 * reusing the source message ids (which would collide with the primary keys
 * of the projected `session_message` table).
 */
export const remapEventData = (data: unknown, next: (old: string) => string): unknown => {
  const walk = (value: unknown, key: string | undefined): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, undefined))
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {}
      for (const [entryKey, entryValue] of Object.entries(value)) output[entryKey] = walk(entryValue, entryKey)
      return output
    }
    if (typeof value === "string" && key !== undefined && ID_KEYS.has(key)) return next(value)
    return value
  }
  return walk(data, undefined)
}
