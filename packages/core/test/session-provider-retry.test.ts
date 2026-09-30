import { describe, expect, test } from "bun:test"
import { AuthenticationReason, InvalidRequestReason, LLMError, RateLimitReason } from "@miao/llm"
import { Effect, Fiber, Ref } from "effect"
import { SessionRunnerProviderRetry } from "@miao/core/session/runner/provider-retry"
import { it } from "./lib/effect"

const providerError = (reason: LLMError["reason"]) => new LLMError({ module: "test", method: "test", reason })

describe("SessionRunnerProviderRetry", () => {
  test("retries catalog misses and transient provider failures", () => {
    expect(SessionRunnerProviderRetry.retryable({ _tag: "SessionRunnerModel.ModelUnavailableError" })).toBe(true)
    expect(
      SessionRunnerProviderRetry.retryable(providerError(new RateLimitReason({ message: "slow down" }))),
    ).toBe(true)
    expect(
      SessionRunnerProviderRetry.retryable(
        providerError(new AuthenticationReason({ message: "expired", kind: "expired" })),
      ),
    ).toBe(true)
  })

  test("does not retry failures a retry cannot fix", () => {
    expect(
      SessionRunnerProviderRetry.retryable(providerError(new InvalidRequestReason({ message: "bad request" }))),
    ).toBe(false)
    expect(SessionRunnerProviderRetry.retryable({ _tag: "SessionRunnerModel.UnsupportedApiError" })).toBe(false)
    expect(SessionRunnerProviderRetry.retryable({ _tag: "Other" })).toBe(false)
  })

  it.live("retries a retryable provider failure", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.gen(function* () {
        yield* Ref.update(attempts, (count) => count + 1)
        return yield* providerError(new RateLimitReason({ message: "again" }))
      })

      const fiber = yield* failing.pipe(
        Effect.retry({
          while: (error) => SessionRunnerProviderRetry.retryable(error),
          schedule: SessionRunnerProviderRetry.providerSchedule,
        }),
        Effect.forkScoped,
      )

      yield* Effect.sleep("2 seconds")
      expect(yield* Ref.get(attempts)).toBeGreaterThan(1)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("fails immediately when a retry cannot help", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.gen(function* () {
        yield* Ref.update(attempts, (count) => count + 1)
        return yield* providerError(new InvalidRequestReason({ message: "bad request" }))
      })

      const exit = yield* failing.pipe(
        Effect.retry({
          while: (error) => SessionRunnerProviderRetry.retryable(error),
          schedule: SessionRunnerProviderRetry.providerSchedule,
        }),
        Effect.exit,
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
