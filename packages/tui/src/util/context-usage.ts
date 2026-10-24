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

/** Remaining capacity only describes a measured or estimated current request. */
export function remainingContext(
  messages: readonly SessionMessage[],
  model?: { providerID: string; id: string; window: number },
) {
  const usage = contextUsage(messages)
  const latest = messages.findLast((item): item is SessionMessageAssistant => item.type === "assistant")
  if (model && latest?.model && (latest.model.providerID !== model.providerID || latest.model.id !== model.id))
    return { label: "Context —", remaining: undefined }
  // Native providers may publish measured usage without a preflight budget.
  // Estimate only against the same served model, never a stale turn or window.
  const estimated =
    usage.percent === undefined &&
    !usage.rejected &&
    !usage.compacted &&
    latest?.tokens !== undefined &&
    model !== undefined &&
    Number.isFinite(model.window) &&
    model.window > 0 &&
    latest.model?.providerID === model.providerID &&
    latest.model.id === model.id &&
    usage.observed !== undefined &&
    usage.observed > 0
  const percent =
    usage.percent ?? (estimated ? Math.round(((usage.observed ?? 0) / (model?.window ?? 1)) * 100) : undefined)
  if (percent === undefined) return { label: "Context —", remaining: undefined }
  const remaining = Math.max(0, Math.min(100, 100 - percent))
  return { label: `Context ${estimated || usage.source === "estimated" ? "~" : ""}${remaining}% left`, remaining }
}
