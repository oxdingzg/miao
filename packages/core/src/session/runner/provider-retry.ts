export * as SessionRunnerProviderRetry from "./provider-retry"

import type { LLMError } from "@miao/llm"
import { Duration, Effect, Schedule } from "effect"

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

/**
 * Ceiling for a pause the provider itself asked for. The endpoint is telling us
 * when it will be ready; honoring anything longer would hold the Session for
 * most of an hour, so a hostile or buggy `Retry-After` is treated as this.
 */
const RETRY_AFTER_MAX_MS = 15 * 60_000

/**
 * The pause before the next attempt: the schedule's own backoff, raised to the
 * delay the provider asked for.
 *
 * Retrying a 429 on a shorter backoff than the endpoint named just spends one
 * of the few attempts on another rejection — with a 60 s budget, a provider
 * that wants 2 minutes never gets a usable second attempt, and the turn fails
 * with the user left to continue it by hand.
 */
export const providerDelay = (error: unknown, delay: Duration.Duration): Duration.Duration => {
  const requested = retryAfterMs(error)
  if (requested === undefined) return delay
  return Duration.max(delay, Duration.millis(Math.min(requested, RETRY_AFTER_MAX_MS)))
}

const retryAfterMs = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined
  if ((error as { readonly _tag: unknown })._tag !== "LLM.Error") return undefined
  // Only a rate limit or a provider-side internal error names a pause; every
  // other reason's `retryAfterMs` would be a header we do not trust.
  const reason = (error as LLMError).reason
  if (reason._tag !== "RateLimit" && reason._tag !== "ProviderInternal") return undefined
  return reason.retryAfterMs
}

export const providerSchedule = Schedule.exponential(500, 1.7).pipe(
  Schedule.either(Schedule.spaced(5_000)),
  Schedule.jittered,
  // The delay has to see the failure that earned it, which is the schedule's
  // input; `passthrough` hands it on as the output.
  Schedule.passthrough,
  Schedule.modifyDelay((error, delay) => Effect.succeed(providerDelay(error, delay))),
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
  // A tool-argument stream that stopped making progress is a stalled transport,
  // not a defective request: the provider went quiet while a call was still
  // open. Replaying rebuilds the same request, and the runner replays only while
  // nothing durable has been produced. The byte budget stays terminal: the same
  // oversized input fails identically.
  if (reason._tag === "InvalidProviderOutput") return reason.toolInput?.budget === "idle"
  return reason.retryable === true
}

/**
 * Whether a turn failure earns a single extra attempt even though {@link
 * retryable} declines it.
 *
 * A request the endpoint rejected (HTTP 400) is not retryable: replaying an
 * identical request normally reproduces it. But a 400 delivered through a
 * gateway commonly wraps an upstream hiccup (`Upstream request failed`) rather
 * than a real defect in our payload, and the schedule then gives up at once —
 * the turn fails and waits for the user to continue. The runner grants exactly
 * one extra attempt for this class so a transient rejection recovers on its
 * own; a deterministic one still fails, at the cost of one replay.
 */
export const selfHealable = (error: { readonly _tag: string }): boolean =>
  error._tag === "LLM.Error" && (error as LLMError).reason._tag === "InvalidRequest"
