import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LLMError, LLMEvent } from "@miao/llm"
import { TransportKeepAlive } from "@miao/llm/route"
import { SessionFirstByteGuard } from "@miao/core/session/runner/first-byte-guard"
import { it } from "./lib/effect"

const first = LLMEvent.textDelta({ id: "answer", text: "hello" })

describe("SessionFirstByteGuard", () => {
  it.effect("fires under the test clock even when the stream subscribes late", () =>
    Effect.gen(function* () {
      const attempt = SessionFirstByteGuard.start()
      const fiber = yield* SessionFirstByteGuard.wrap(Stream.never, {
        attempt,
        firstByteTimeoutMs: 100,
        streamIdleTimeoutMs: 500,
        eventIdleTimeoutMs: 500,
      }).pipe(Stream.runDrain, Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      expect(error.reason.message).toBe(
        "provider sent no response headers within 100ms (set MIAO_LLM_FIRST_BYTE_TIMEOUT_MS to adjust, 0 disables)",
      )
    }),
  )

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

  it.live("times out while waiting for response headers", () =>
    Effect.gen(function* () {
      TransportKeepAlive.clearStale()
      const attempt = SessionFirstByteGuard.start()
      const error = yield* SessionFirstByteGuard.wrap(Stream.never, {
        attempt,
        firstByteTimeoutMs: 20,
        streamIdleTimeoutMs: 0,
        eventIdleTimeoutMs: 0,
      }).pipe(Stream.runDrain, Effect.flip)
      expect(error.reason._tag).toBe("Transport")
      expect(error.reason.message).toBe(
        "provider sent no response headers within 20ms (set MIAO_LLM_FIRST_BYTE_TIMEOUT_MS to adjust, 0 disables)",
      )
      expect(error.retryable).toBe(true)
      expect(TransportKeepAlive.isStale()).toBe(true)
    }).pipe(Effect.ensuring(Effect.sync(() => TransportKeepAlive.clearStale()))),
  )

  it.live("waits past the old deadline for a slow first event after headers arrive", () =>
    Effect.gen(function* () {
      const attempt = SessionFirstByteGuard.start()
      const source = Stream.fromEffect(Effect.sleep("40 millis").pipe(Effect.as(first))).pipe(
        Stream.onStart(Effect.sync(() => attempt.activity.headers())),
      )
      expect(
        yield* SessionFirstByteGuard.wrap(source, {
          attempt,
          firstByteTimeoutMs: 20,
          streamIdleTimeoutMs: 500,
          eventIdleTimeoutMs: 500,
        }).pipe(Stream.runCollect),
      ).toEqual([first])
    }),
  )

  it.live("keep-alive bytes do not hide a stalled event stream", () =>
    Effect.gen(function* () {
      const attempt = SessionFirstByteGuard.start()
      const ticker = yield* Effect.gen(function* () {
        while (true) {
          attempt.activity.bytes(1)
          yield* Effect.sleep("10 millis")
        }
      }).pipe(Effect.forkChild)
      const error = yield* SessionFirstByteGuard.wrap(Stream.never, {
        attempt,
        firstByteTimeoutMs: 20,
        streamIdleTimeoutMs: 20,
        eventIdleTimeoutMs: 50,
      }).pipe(Stream.runDrain, Effect.flip)
      yield* Fiber.interrupt(ticker)
      expect(error.reason.message).toBe(
        "provider produced no stream event for 50ms (set MIAO_LLM_EVENT_IDLE_TIMEOUT_MS to adjust, 0 disables)",
      )
    }),
  )

  it.live("widens the header deadline by the encoded request size", () =>
    Effect.gen(function* () {
      const attempt = SessionFirstByteGuard.start()
      const source = Stream.fromEffect(Effect.sleep("40 millis").pipe(Effect.as(first))).pipe(
        Stream.onStart(Effect.sync(() => attempt.activity.requestBytes(64 * 1024))),
      )
      expect(
        yield* SessionFirstByteGuard.wrap(source, {
          attempt,
          firstByteTimeoutMs: 20,
          streamIdleTimeoutMs: 0,
          eventIdleTimeoutMs: 0,
        }).pipe(Stream.runCollect),
      ).toEqual([first])
    }),
  )

  it.live("resets the phase when the same attempt is subscribed again", () =>
    Effect.gen(function* () {
      const attempt = SessionFirstByteGuard.start()
      yield* SessionFirstByteGuard.wrap(Stream.never, {
        attempt,
        firstByteTimeoutMs: 20,
        streamIdleTimeoutMs: 0,
        eventIdleTimeoutMs: 0,
      }).pipe(Stream.runDrain, Effect.flip)
      const source = Stream.fromEffect(Effect.sleep("10 millis").pipe(Effect.as(first))).pipe(
        Stream.onStart(Effect.sync(() => attempt.activity.headers())),
      )
      expect(
        yield* SessionFirstByteGuard.wrap(source, {
          attempt,
          firstByteTimeoutMs: 500,
          streamIdleTimeoutMs: 500,
          eventIdleTimeoutMs: 500,
        }).pipe(Stream.runCollect),
      ).toEqual([first])
    }),
  )
})
