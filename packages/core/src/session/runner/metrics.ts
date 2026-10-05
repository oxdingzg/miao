export * as SessionRunnerMetrics from "./metrics"

export type TokenUsage = {
  readonly input: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Provider billing floor below which no prompt prefix is cached at all. */
const MIN_CACHEABLE_TOKENS = 1_024

/** Total prompt tokens the provider billed for, cached and fresh alike. */
export const promptTokens = (usage: TokenUsage) => usage.input + usage.cache.read + usage.cache.write

/** Share of input tokens served from the prompt cache, matching `/usage` semantics. */
export const cacheHitRatio = (usage: TokenUsage) => {
  const read = Math.max(0, usage.cache.read)
  const total = Math.max(0, usage.input) + read + Math.max(0, usage.cache.write)
  return total <= 0 ? 0 : read / total
}

/**
 * Whether the turn missed the prompt cache.
 *
 * Anthropic and Bedrock bill cache writes, so a positive write is the miss. An
 * implicit cache reports no write at all — OpenAI Chat, Responses and Gemini only
 * ever report the tokens they read back — so the signal there is the other side
 * of the same coin: a prompt long enough for the provider to cache anything,
 * answered with nothing read. Below the cacheable floor a miss is not observable
 * and not reported, which also keeps a provider that sends no usage at all from
 * reading as a miss.
 */
export const cacheMissed = (usage: TokenUsage) => {
  if (usage.cache.write > 0) return true
  return usage.cache.read <= 0 && promptTokens(usage) >= MIN_CACHEABLE_TOKENS
}

export type CacheMissCause = "none" | "cold" | "rebuild" | "prefix-change"

/**
 * Classify a cache miss so telemetry can distinguish one by cause.
 *
 * Actions that invalidate the prompt-cache prefix:
 * - compaction rewrites history (`rebuild`);
 * - the first turn of a session, or the first turn after the warm window, is `cold`;
 * - an agent/model switch, a system-context epoch change, or a tool-definition
 *   change alters the prefix of a warm session (`prefix-change`).
 */
export const cacheMissCause = (input: {
  readonly miss: boolean
  readonly warm: boolean
  readonly expectedRebuild: boolean
}): CacheMissCause => {
  if (!input.miss) return "none"
  if (input.expectedRebuild) return "rebuild"
  if (!input.warm) return "cold"
  return "prefix-change"
}
