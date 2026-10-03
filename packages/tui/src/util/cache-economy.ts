import type { AssistantMessage } from "@miao/schema/view-models"
import type { ProviderLike } from "./currency"

export type CacheEconomy = {
  readonly read: number
  readonly write: number
  /** Discount earned by cache reads minus the premium paid to write the cache. */
  readonly saved: number
}

/** Per-million-token rates, in the model's price currency. */
type CachePrice = {
  readonly input: number
  readonly cache_read: number
  readonly cache_write: number
}

/**
 * Cache economics across a whole session, not just the current turn. A cache
 * read bills below the input rate and a cache write above it, so the session
 * nets the reads' discount against the writes' premium. A model that quotes no
 * price for one direction bills it at the input rate, which makes that term
 * zero instead of a guess.
 *
 * `multiplier` scales each message's rate, which is how a provider that bills
 * by time of day (see cache-pricing.ts) reaches the figures without this
 * function knowing about any particular provider.
 */
export function cacheEconomy(
  messages: ReadonlyArray<AssistantMessage>,
  providers: ReadonlyArray<ProviderLike>,
  multiplier: (message: AssistantMessage) => number = () => 1,
): CacheEconomy {
  return messages.reduce(
    (total, message) => {
      const tokens = message.tokens
      // The tiers below apply to the request's inclusive input, which is what
      // the runner bills against, so a session that outgrew the base rate is
      // measured at the rate it actually paid.
      const price = priceFor(
        providers.find((provider) => provider.id === message.providerID)?.models[message.modelID],
        tokens.input + tokens.cache.read + tokens.cache.write,
      )
      if (!price) return total
      const read = tokens.cache.read
      const write = tokens.cache.write
      // A discounted rate moves both endpoints of the spread, so the factor
      // scales the difference rather than either side of it.
      const net = read * (price.input - price.cache_read) - write * (price.cache_write - price.input)
      return {
        read: total.read + read,
        write: total.write + write,
        saved: total.saved + (net * multiplier(message)) / 1_000_000,
      }
    },
    { read: 0, write: 0, saved: 0 },
  )
}

/** The largest context tier the input exceeds, and the base rate otherwise. */
function priceFor(model: unknown, contextTokens: number): CachePrice | undefined {
  if (typeof model !== "object" || model === null) return undefined
  const cost = (model as { cost?: { tiers?: unknown } }).cost
  const base = price(cost)
  if (!base || !Array.isArray(cost?.tiers)) return base
  const tiered = cost.tiers
    .flatMap((item) => {
      const size = (item as { tier?: { size?: unknown } })?.tier?.size
      const rate = price(item)
      return rate && typeof size === "number" ? [{ rate, size }] : []
    })
    .filter((item) => contextTokens > item.size)
    .sort((a, b) => b.size - a.size)[0]
  return tiered?.rate ?? base
}

function price(raw: unknown): CachePrice | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const cost = raw as { input?: unknown; cache?: { read?: unknown; write?: unknown } }
  if (typeof cost.input !== "number") return undefined
  return {
    input: cost.input,
    cache_read: typeof cost.cache?.read === "number" ? cost.cache.read : cost.input,
    cache_write: typeof cost.cache?.write === "number" ? cost.cache.write : cost.input,
  }
}
