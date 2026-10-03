import type { AssistantMessage } from "@miao/sdk/v2"

/**
 * How long the prompt cache behind a session has been alive. Providers do not
 * report cache expiry, so this counts from the last turn that actually touched
 * the cache and assumes the provider's documented lifetime: an estimate, not
 * an expiry date.
 */

/** Documented prompt-cache lifetimes, in milliseconds, by fragment of the provider id. */
const TTL_BY_PROVIDER: ReadonlyArray<readonly [string, number]> = [
  ["deepseek", 2 * 60 * 60_000],
  ["google", 60 * 60_000],
  ["gemini", 60 * 60_000],
  ["anthropic", 5 * 60_000],
  ["claude", 5 * 60_000],
  ["openai", 5 * 60_000],
]
/** The shortest documented lifetime, so an unknown provider never overstates freshness. */
const DEFAULT_TTL = 5 * 60_000

export type CacheTtl = {
  readonly ttl: number
  /** When the cache was last touched. */
  readonly startedAt: number
  /** How long ago that was. */
  readonly elapsed: number
  readonly state: "fresh" | "aging" | "stale"
}

export function cacheTtl(messages: ReadonlyArray<AssistantMessage>, now: number): CacheTtl | undefined {
  // A summary reports on earlier turns rather than issuing its own request, so
  // counting one would restart the clock without the cache being touched.
  const last = messages.findLast(
    (message) => !message.summary && (message.tokens.cache.read > 0 || message.tokens.cache.write > 0),
  )
  if (!last) return
  const startedAt = last.time.completed ?? last.time.created
  const ttl = ttlFor(last.providerID)
  const elapsed = now - startedAt
  return {
    ttl,
    startedAt,
    elapsed,
    // Past twice the lifetime the cache is certainly gone; between the two it
    // is close enough to expiry to be worth flagging.
    state: elapsed < ttl ? "fresh" : elapsed < ttl * 2 ? "aging" : "stale",
  }
}

function ttlFor(providerID: string) {
  const provider = providerID.toLowerCase()
  return TTL_BY_PROVIDER.find(([name]) => provider.includes(name))?.[1] ?? DEFAULT_TTL
}
