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
