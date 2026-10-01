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
  // A Session with no model of its own resolves against the catalog's default,
  // which a cold location is missing for the same reason a selected model can
  // be: the plugins that build the catalog have not run yet. Sessions that name
  // a model already wait that window out, so without this the sessions created
  // without one — `session.create` allows it, and `session.fork` and subagent
  // creation always do it — fail on a cold catalog that a named model survives.
  // The cost: a location with nothing to resolve at all, every provider
  // unconfigured, now spends the catalog budget before reporting the error it
  // would otherwise report at once.
  if (error._tag === "SessionRunnerModel.ModelNotSelectedError") return true
  if (error._tag !== "LLM.Error") return false
  const reason = (error as LLMError).reason
  // Refreshing helps a missing, invalid or expired credential; a 403 means the
  // credential is fine but not allowed (OpenCode's free tier answers miao this
  // way), and retrying it only burned the whole provider budget before failing.
  if (reason._tag === "Authentication") return reason.kind !== "insufficient-permissions"
  return reason.retryable === true
}
