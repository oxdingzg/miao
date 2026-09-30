export * as SessionRunnerProviderRetry from "./provider-retry"

import type { LLMError } from "@miao/llm"
import { Schedule } from "effect"

/**
 * Retry policy for one Session turn.
 *
 * The V2 runner shipped without provider retries, so a transient provider
 * failure — a rate limit, a 5xx, a dropped connection, an OAuth credential
 * being refreshed, or a model that is briefly missing from the catalog while a
 * credential or plugin settles — failed the turn outright and left the Session
 * looking stuck. Retry only while nothing durable has been published (the call
 * sites own that gate): once text, reasoning, or a tool call is visible,
 * replaying the attempt would duplicate it.
 */

/** Budget for retrying a provider attempt that failed before publishing. */
const PROVIDER_TIMEOUT_MS = 60_000

/** Budget for retrying model resolution against a catalog gap. */
const CATALOG_TIMEOUT_MS = 10_000

export const providerSchedule = Schedule.exponential(500, 1.7).pipe(
  Schedule.either(Schedule.spaced(5_000)),
  Schedule.jittered,
  Schedule.while((meta) => meta.elapsed < PROVIDER_TIMEOUT_MS),
)

export const catalogSchedule = Schedule.exponential(250, 2).pipe(
  Schedule.either(Schedule.spaced(1_000)),
  Schedule.jittered,
  Schedule.while((meta) => meta.elapsed < CATALOG_TIMEOUT_MS),
)

/**
 * Whether a turn failure is worth another attempt.
 *
 * Model resolution misses are included: a provider can vanish from the catalog
 * while its credential or plugin settles, and the next lookup sees it again.
 * Authentication failures are included for the same reason —
 * `Integration.connection.resolve` refreshes an expired credential on its own,
 * so a later attempt can succeed.
 */
export const retryable = (error: { readonly _tag: string }): boolean => {
  if (error._tag === "SessionRunnerModel.ModelUnavailableError") return true
  if (error._tag !== "LLM.Error") return false
  const reason = (error as LLMError).reason
  if (reason._tag === "Authentication") return true
  return reason.retryable === true
}
