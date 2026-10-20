export * as SessionFirstByteGuard from "./first-byte-guard"

import { Deferred, Effect, Stream } from "effect"
import { LLMError, TransportReason, type LLMEvent } from "@miao/llm"
import { TransportKeepAlive } from "@miao/llm/route"
import { DEFAULT_LLM_FIRST_BYTE_TIMEOUT_MS, Flag } from "../../flag/flag"

/**
 * Bounds silent provider attempts; after the first event the timer is cancelled.
 *
 * A silent attempt is also the shape of a pooled keep-alive socket that the
 * peer, proxy, or tunnel dropped without a reset: the request is written into
 * the dead socket and no byte ever comes back. Retrying over that same pooled
 * connection reproduces the silence, so abandon the pool for the replay and
 * let it open a fresh connection.
 */
export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, options?: { timeoutMs?: number }) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const configured = options?.timeoutMs ?? Flag.MIAO_LLM_FIRST_BYTE_TIMEOUT_MS
      const timeoutMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_LLM_FIRST_BYTE_TIMEOUT_MS
      if (timeoutMs === 0) return stream
      const received = yield* Deferred.make<void>()
      const watchdog = Deferred.await(received).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.sync(() => TransportKeepAlive.markStale()).pipe(
              Effect.andThen(
                Effect.fail(
                  new LLMError({
                    module: "SessionFirstByteGuard",
                    method: "stream",
                    reason: new TransportReason({
                      message: `provider produced no stream event within ${timeoutMs}ms (set MIAO_LLM_FIRST_BYTE_TIMEOUT_MS to adjust, 0 disables)`,
                      kind: "Timeout",
                    }),
                  }),
                ),
              ),
            ),
        }),
        // Completion of interruptWhen's effect would end the provider stream.
        // Keep this branch pending after cancelling its timer on the first event.
        Effect.andThen(Effect.never),
      )
      return stream.pipe(
        Stream.tap(() => Deferred.succeed(received, undefined)),
        Stream.interruptWhen(watchdog),
      )
    }),
  )
}
