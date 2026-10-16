import type { SessionMessage, SessionMessageAssistant } from "@miao/schema/view-models"

/** Never present a previous successful turn's count as a rejected request's size. */
export function contextUsage(messages: readonly SessionMessage[]) {
  const latest = messages.findLast((item): item is SessionMessageAssistant => item.type === "assistant")
  const settled = messages.findLast(
    (item): item is SessionMessageAssistant => item.type === "assistant" && item.tokens !== undefined && !item.error,
  )
  const observed = settled?.tokens
    ? settled.tokens.input + settled.tokens.cache.read + settled.tokens.cache.write
    : undefined
  const budget = latest?.contextBudget
  const rejected = latest?.error !== undefined
  const compacted =
    messages.findLastIndex((item) => item.type === "compaction") >
    messages.findLastIndex((item) => item.type === "assistant")
  return {
    observed,
    compacted,
    budget: compacted ? undefined : budget,
    rejected,
    tokens: rejected || compacted ? undefined : budget?.input,
    source: budget?.source,
    percent:
      !rejected && !compacted && budget && budget.window > 0
        ? Math.round((budget.input / budget.window) * 100)
        : undefined,
  }
}

export function contextLabel(messages: readonly SessionMessage[], format: (tokens: number) => string) {
  const state = contextUsage(messages)
  if (state.rejected) return "request failed"
  if (state.compacted) return "compacted"
  if (state.tokens !== undefined)
    return `${state.source === "estimated" ? "~" : ""}${format(state.tokens)}${state.percent === undefined ? "" : ` (${state.percent}%)`}`
  return state.observed === undefined ? undefined : `last ${format(state.observed)}`
}
