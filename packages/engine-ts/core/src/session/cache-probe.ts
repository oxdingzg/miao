export * as SessionCacheProbe from "./cache-probe"

import { createHash } from "node:crypto"

/** Fingerprints describe the normalized request, not provider KV residency. */
type Request = {
  readonly model: unknown
  readonly tools: ReadonlyArray<unknown>
  readonly system: unknown
  readonly messages: ReadonlyArray<unknown>
}
type Snapshot = {
  readonly modelHash: string
  readonly toolsHash: string
  readonly systemPromptHash: string
  readonly historyHash: string
  readonly messageCount: number
  readonly inputTokens: number | null
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify({ value })).digest("hex")

/** Process-local telemetry only. Restart/eviction makes evidence unavailable. */
export function make(capacity = 256) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid cache probe capacity")
  const completed = new Map<string, Snapshot>()
  const forks = new Map<string, { parentID: string; snapshot: Snapshot | undefined }>()
  const bound = <A>(map: Map<string, A>, id: string, value: A) => {
    map.delete(id)
    map.set(id, value)
    if (map.size > capacity) {
      const oldest = map.keys().next()
      if (!oldest.done) map.delete(oldest.value)
    }
  }
  return {
    complete(sessionID: string, request: Request, inputTokens: number | null) {
      bound(completed, sessionID, {
        modelHash: hash(request.model),
        toolsHash: hash(request.tools),
        systemPromptHash: hash(request.system),
        historyHash: hash(request.messages),
        messageCount: request.messages.length,
        inputTokens: inputTokens !== null && Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : null,
      })
    },
    fork(parentID: string, childID: string) {
      // Capture the completed parent at the fork boundary. Later parent turns
      // cannot silently move the child's comparison target.
      bound(forks, childID, { parentID, snapshot: completed.get(parentID) })
      completed.delete(childID)
    },
    invalidate(sessionID: string) {
      completed.delete(sessionID)
      forks.delete(sessionID)
    },
    consume(sessionID: string, request: Request) {
      const fork = forks.get(sessionID)
      forks.delete(sessionID)
      if (!fork) return undefined
      const before = fork.snapshot
      if (!before)
        return {
          parentID: fork.parentID,
          state: "unavailable",
          representation: "normalized-request",
          serverCacheState: "unknown",
        }
      const toolsHash = hash(request.tools)
      const systemPromptHash = hash(request.system)
      const modelMatches = before.modelHash === hash(request.model)
      const toolsMatch = before.toolsHash === toolsHash
      const systemMatches = before.systemPromptHash === systemPromptHash
      const historyMatches =
        request.messages.length >= before.messageCount &&
        hash(request.messages.slice(0, before.messageCount)) === before.historyHash
      return {
        parentID: fork.parentID,
        state: modelMatches && toolsMatch && systemMatches && historyMatches ? "prefix-match" : "prefix-changed",
        representation: "normalized-request",
        serverCacheState: "unknown",
        parentInputTokens: before.inputTokens,
        parentMessageCount: before.messageCount,
        toolsHash,
        systemPromptHash,
        modelMatches,
        toolsMatch,
        systemMatches,
        historyMatches,
      }
    },
  }
}

export const current = make()
