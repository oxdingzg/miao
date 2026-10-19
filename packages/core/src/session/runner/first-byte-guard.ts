export * as SessionFirstByteGuard from "./first-byte-guard"

import { Deferred, Effect, Stream } from "effect"
import { LLMError, TransportReason, type LLMEvent } from "@miao/llm"
import { Flag } from "../../flag/flag"

/** Bounds silent provider attempts; after the first event the timer is cancelled. */
export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, options?: { timeoutMs?: number }) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const configured = options?.timeoutMs ?? Flag.MIAO_LLM_FIRST_BYTE_TIMEOUT_MS
      const timeoutMs = Number.isFinite(configured) && configured >= 0 ? configured : 60_000
      if (timeoutMs === 0) return stream
      const received = yield* Deferred.make<void>()
      const watchdog = Deferred.await(received).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
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
