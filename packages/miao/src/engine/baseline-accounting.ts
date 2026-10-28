/** All measured attempts are charged to verified completions, including failures and retries. */
export function summarizeAccounting(
  runs: readonly {
    outcome?: string | null
    elapsedMs?: number | null
    attempts: readonly {
      inputTokens?: number | null
      outputTokens?: number | null
      cost?: number | null
    }[]
  }[],
) {
  const attempts = runs.flatMap((run) => run.attempts)
  const completed = runs.filter((run) => run.outcome === "passed").length
  const total = (key: "inputTokens" | "outputTokens" | "cost") =>
    runs.length > 0 &&
    // An empty list cannot prove that an interrupted run incurred no usage.
    runs.every((run) => run.attempts.length > 0) &&
    attempts.every((attempt) => {
      const value = attempt[key]
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        (key === "cost" || Number.isSafeInteger(value))
      )
    })
      ? attempts.reduce((sum, attempt) => sum + (attempt[key] ?? 0), 0)
      : null
  const totals = {
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cost: total("cost"),
    elapsedMs:
      runs.length > 0 &&
      runs.every((run) => typeof run.elapsedMs === "number" && Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0)
        ? runs.reduce((sum, run) => sum + (run.elapsedMs ?? 0), 0)
        : null,
  }
  const perCompleted = (value: number | null) => (completed > 0 && value !== null ? value / completed : null)
  return {
    runs: runs.length,
    passed: completed,
    failed: runs.filter((run) => run.outcome === "failed").length,
    unverified: runs.filter((run) => run.outcome !== "passed" && run.outcome !== "failed").length,
    attempts: attempts.length,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cost: totals.cost,
    totalElapsedMs: totals.elapsedMs,
    perCompletedTask: {
      inputTokens: perCompleted(totals.inputTokens),
      outputTokens: perCompleted(totals.outputTokens),
      cost: perCompleted(totals.cost),
      elapsedMs: perCompleted(totals.elapsedMs),
    },
  }
}

export * as EngineBaselineAccounting from "./baseline-accounting"
