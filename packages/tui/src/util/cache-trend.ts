import type { TranscriptAssistantMessage } from "@miao/schema/view-models"

/**
 * Which way the cache hit rate is moving over recent turns. Any single turn
 * wobbles with the tool calls it happened to make, so the window is split in
 * half and the halves compared rather than the first turn against the last.
 */

/** Percentage points of movement before the change is worth showing. */
const THRESHOLD = 0.03
/** Below this many priced turns the comparison would only reflect noise. */
const MIN_SAMPLES = 4

export type CacheTrend = "up" | "down" | "flat"

export function cacheTrend(messages: ReadonlyArray<TranscriptAssistantMessage>, window = 6): CacheTrend | undefined {
  const rates = messages
    .slice(-window)
    .map(hitRate)
    .filter((rate): rate is number => rate !== undefined)
  if (rates.length < MIN_SAMPLES) return
  const half = Math.floor(rates.length / 2)
  const delta = average(rates.slice(-half)) - average(rates.slice(0, half))
  if (delta > THRESHOLD) return "up"
  if (delta < -THRESHOLD) return "down"
  return "flat"
}

/** The share of a turn's input that came from the cache, matching the hit rate the sidebar shows. */
function hitRate(message: TranscriptAssistantMessage) {
  const tokens = message.tokens
  if (!tokens) return undefined
  const total = tokens.input + tokens.cache.read + tokens.cache.write
  return total > 0 ? tokens.cache.read / total : undefined
}

function average(values: ReadonlyArray<number>) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
