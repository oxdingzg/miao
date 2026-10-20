import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { LLMError, LLMEvent } from "@miao/llm"
import { TransportKeepAlive } from "@miao/llm/route"
import { SessionFirstByteGuard } from "@miao/core/session/runner/first-byte-guard"
import { it } from "./lib/effect"

const first = LLMEvent.textDelta({ id: "answer", text: "hello" })

describe("SessionFirstByteGuard", () => {
  it.live("times out, closes the source, and retires the connection pool", () =>
    Effect.gen(function* () {
      TransportKeepAlive.clearStale()
      let closed = false
      const source = Stream.never.pipe(
        Stream.ensuring(
          Effect.sync(() => {
            closed = true
          }),
        ),
      )
      const error = yield* SessionFirstByteGuard.wrap(source, { timeoutMs: 20 }).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason._tag).toBe("Transport")
      expect(error.reason.message).toBe(
        "provider produced no stream event within 20ms (set MIAO_LLM_FIRST_BYTE_TIMEOUT_MS to adjust, 0 disables)",
      )
      expect(error.retryable).toBe(true)
      expect(closed).toBe(true)
      // The next attempt must not reuse the socket the silent one hung on.
      expect(TransportKeepAlive.isStale()).toBe(true)
    }).pipe(Effect.ensuring(Effect.sync(() => TransportKeepAlive.clearStale()))),
  )

  it.live("does not delay immediate completion by waiting for the watchdog duration", () =>
    Effect.gen(function* () {
      const result = yield* SessionFirstByteGuard.wrap(Stream.make(first), { timeoutMs: 60_000 }).pipe(
        Stream.runCollect,
        Effect.timeout("1 second"),
      )
      expect(result).toEqual([first])
      expect(
        yield* SessionFirstByteGuard.wrap(Stream.empty, { timeoutMs: 60_000 }).pipe(
          Stream.runCollect,
          Effect.timeout("1 second"),
        ),
      ).toEqual([])
    }),
  )

  it.live("cancels the timer after the first event rather than applying a whole-turn timeout", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.make(first),
        Stream.fromEffect(Effect.sleep("60 millis").pipe(Effect.as(first))),
      )
      expect(yield* SessionFirstByteGuard.wrap(source, { timeoutMs: 20 }).pipe(Stream.runCollect)).toEqual([
        first,
        first,
      ])
    }),
  )

  it.live("disabled deadlines and external interruption preserve upstream cleanup", () =>
    Effect.forEach([0, 60_000], (timeoutMs) =>
      Effect.gen(function* () {
        let closed = false
        const ready = yield* Deferred.make<void>()
        const source = Stream.fromEffect(Deferred.succeed(ready, undefined)).pipe(
          Stream.flatMap(() => Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              closed = true
            }),
          ),
        )
        const running = yield* SessionFirstByteGuard.wrap(source, { timeoutMs }).pipe(Stream.runDrain, Effect.forkChild)
        // The source must enter its owned scope before interruption can verify
        // upstream cleanup. Scheduler speed is not a readiness signal.
        yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
        if (timeoutMs === 0) yield* Effect.sleep("50 millis")
        expect(running.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(running).pipe(Effect.timeout("1 second"))
        expect(closed).toBe(true)
      }),
    ),
  )
})
