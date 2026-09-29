export * as SessionRunnerMetrics from "./metrics"

export type TokenUsage = {
  readonly input: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Share of input tokens served from the prompt cache, matching `/usage` semantics. */
export const cacheHitRatio = (usage: TokenUsage) => {
  const read = Math.max(0, usage.cache.read)
  const total = Math.max(0, usage.input) + read + Math.max(0, usage.cache.write)
  return total <= 0 ? 0 : read / total
}

export type CacheMissCause = "none" | "cold" | "rebuild" | "prefix-change"

/**
 * Classify a cache write so telemetry can distinguish a miss by cause.
 *
 * Actions that invalidate the prompt-cache prefix and force a write:
 * - compaction rewrites history (`rebuild`);
 * - the first turn of a session, or the first turn after the warm window, is `cold`;
 * - an agent/model switch, a system-context epoch change, or a tool-definition
 *   change alters the prefix of a warm session (`prefix-change`).
 */
export const cacheMissCause = (input: {
  readonly cacheWrite: number
  readonly warm: boolean
  readonly expectedRebuild: boolean
}): CacheMissCause => {
  if (input.cacheWrite <= 0) return "none"
  if (input.expectedRebuild) return "rebuild"
  if (!input.warm) return "cold"
  return "prefix-change"
}
