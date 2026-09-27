export * as SessionRunnerCost from "./cost"

import type { Usage } from "@miao/llm"
import type { ModelV2 } from "../../model"

const finite = (value: number | undefined) => (Number.isFinite(value) ? (value ?? 0) : 0)

// Models report per-million-token rates. A base entry has no `tier`; context
// tiers apply once the request's inclusive input grows past their `size`, and
// the largest matching tier wins.
const rateFor = (costs: ModelV2.Info["cost"], contextTokens: number) =>
  costs
    .filter((item) => item.tier !== undefined && contextTokens > item.tier.size)
    .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ??
  costs.find((item) => item.tier === undefined)

const perMillion = (tokens: number, value: number) => (Math.max(0, finite(tokens)) * Math.max(0, finite(value))) / 1_000_000

/** Dollar cost for one provider step at the model's tiered list rates. */
export const of = (costs: ModelV2.Info["cost"], usage: Usage | undefined) => {
  const rate = rateFor(costs, Math.max(0, finite(usage?.inputTokens)))
  if (!rate) return 0
  return Math.max(
    0,
    perMillion(usage?.nonCachedInputTokens ?? 0, rate.input) +
      perMillion(usage?.visibleOutputTokens ?? 0, rate.output) +
      // Reasoning tokens have no separate price; charge them at the output rate.
      perMillion(usage?.reasoningTokens ?? 0, rate.output) +
      perMillion(usage?.cacheReadInputTokens ?? 0, rate.cache.read) +
      perMillion(usage?.cacheWriteInputTokens ?? 0, rate.cache.write),
  )
}
