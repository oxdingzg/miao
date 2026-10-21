export * as SessionFirstByteGuard from "./first-byte-guard"

import { Clock, Effect, Option, Queue, Stream } from "effect"
import { LLMError, TransportReason, type LLMEvent, type StreamActivity } from "@miao/llm"
import { TransportKeepAlive } from "@miao/llm/route"
import {
  DEFAULT_LLM_EVENT_IDLE_TIMEOUT_MS,
  DEFAULT_LLM_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  Flag,
} from "../../flag/flag"

/** One provider attempt's shared liveness state. */
export interface Attempt {
  readonly activity: StreamActivity
  readonly state: AttemptState
}

interface AttemptState {
  phase: "headers" | "stream"
  startedAt: number
  lastBytesAt: number
  lastEventAt: number
  requestBytes: number
  queue: Queue.Queue<"headers" | "bytes" | "event"> | undefined
}

type Token = "headers" | "bytes" | "event"

export interface Options {
  /** Legacy single pre-event deadline. Ignored when `attempt` is present. */
  readonly timeoutMs?: number
  /** Deadline for response headers, before any body byte arrives. */
  readonly firstByteTimeoutMs?: number
  /** Deadline with no response bytes, including protocol keep-alives. */
  readonly streamIdleTimeoutMs?: number
  /** Deadline with no canonical stream event. */
  readonly eventIdleTimeoutMs?: number
  readonly attempt?: Attempt
}

const REQUEST_BYTES_PER_SECOND = 32 * 1024
const MAX_REQUEST_ALLOWANCE_MS = 30 * 60_000

/**
 * Starts liveness tracking for one provider attempt.
 *
 * The runner hands this activity to `llm.stream` so the transport can report
 * headers and wire bytes, then wraps the same stream with {@link wrap}. Each
 * subscription creates a fresh queue and clock origin, so a retried attempt is
 * judged on its own connection rather than inheriting the first one's progress.
 */
export function start(): Attempt {
  const state: AttemptState = {
    phase: "headers",
    startedAt: 0,
    lastBytesAt: 0,
    lastEventAt: 0,
    requestBytes: 0,
    queue: undefined,
  }
  const signal = (token: Token) => {
    if (state.queue) Queue.offerUnsafe(state.queue, token)
  }
  return {
    state,
    activity: {
      headers: () => signal("headers"),
      bytes: (count) => {
        if (count > 0) signal("bytes")
      },
      requestBytes: (count) => {
        if (Number.isFinite(count) && count > 0) state.requestBytes = count
      },
    },
  }
}

/**
 * Bounds a silent provider attempt without treating a slow first token as a
 * dead connection.
 *
 * Three independent phases replace the old single pre-event deadline:
 *
 * 1. waiting for response headers (widened by the encoded request size);
 * 2. waiting for any wire byte, including SSE keep-alives;
 * 3. waiting for a canonical event, even while keep-alives keep the socket warm.
 *
 * A silent attempt is also the shape of a pooled keep-alive socket that the
 * peer, proxy, or tunnel dropped without a reset. Every timeout retires the
 * pool so the replay opens a fresh connection.
 */
export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, options?: Options) {
  if (options?.attempt === undefined) return legacyWrap(stream, options?.timeoutMs)
  const attempt = options.attempt
  const firstByteMs = resolve(
    options.firstByteTimeoutMs,
    Flag.MIAO_LLM_FIRST_BYTE_TIMEOUT_MS,
    DEFAULT_LLM_FIRST_BYTE_TIMEOUT_MS,
  )
  const streamIdleMs = resolve(
    options.streamIdleTimeoutMs,
    Flag.MIAO_LLM_STREAM_IDLE_TIMEOUT_MS,
    DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  )
  const eventIdleMs = resolve(
    options.eventIdleTimeoutMs,
    Flag.MIAO_LLM_EVENT_IDLE_TIMEOUT_MS,
    DEFAULT_LLM_EVENT_IDLE_TIMEOUT_MS,
  )
  // `MIAO_LLM_FIRST_BYTE_TIMEOUT_MS=0` remains the escape hatch that turns the
  // whole watchdog off, as it did when there was only one deadline.
  if (firstByteMs === 0) return stream
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Token>()
      attempt.state.phase = "headers"
      attempt.state.requestBytes = 0
      attempt.state.queue = queue
      const watchdog = watch(attempt.state, queue, firstByteMs, streamIdleMs, eventIdleMs)
      return stream.pipe(
        Stream.tap(() => Effect.sync(() => Queue.offerUnsafe(queue, "event"))),
        Stream.interruptWhen(watchdog),
      )
    }),
  )
}

function watch(
  state: AttemptState,
  queue: Queue.Queue<Token>,
  firstByteMs: number,
  streamIdleMs: number,
  eventIdleMs: number,
) {
  return Effect.gen(function* () {
    // Anchor the deadlines here, when this fiber actually starts, rather than at
    // subscription: under a virtual clock the test can advance time between the
    // two, and an absolute anchor taken earlier would already be expired.
    const startedAt = yield* Clock.currentTimeMillis
    state.startedAt = startedAt
    state.lastBytesAt = startedAt
    state.lastEventAt = startedAt
    while (true) {
      const now = yield* Clock.currentTimeMillis
      const deadline = nextDeadline(state, firstByteMs, streamIdleMs, eventIdleMs)
      if (!Number.isFinite(deadline)) return yield* Effect.never
      if (deadline <= now) {
        yield* Effect.sync(() => TransportKeepAlive.markStale())
        return yield* Effect.fail(timeoutError(state, now, firstByteMs, streamIdleMs, eventIdleMs))
      }
      const token = yield* Queue.take(queue).pipe(Effect.timeoutOption(deadline - now))
      if (Option.isNone(token)) {
        yield* Effect.sync(() => TransportKeepAlive.markStale())
        return yield* Effect.fail(
          timeoutError(state, yield* Clock.currentTimeMillis, firstByteMs, streamIdleMs, eventIdleMs),
        )
      }
      const at = yield* Clock.currentTimeMillis
      state.phase = "stream"
      state.lastBytesAt = at
      if (token.value === "event") state.lastEventAt = at
    }
  })
}

function nextDeadline(state: AttemptState, firstByteMs: number, streamIdleMs: number, eventIdleMs: number) {
  if (state.phase === "headers") return state.startedAt + firstByteMs + requestAllowance(state)
  return Math.min(
    streamIdleMs === 0 ? Number.POSITIVE_INFINITY : state.lastBytesAt + streamIdleMs,
    eventIdleMs === 0 ? Number.POSITIVE_INFINITY : state.lastEventAt + eventIdleMs,
  )
}

function requestAllowance(state: AttemptState) {
  return Math.min(MAX_REQUEST_ALLOWANCE_MS, Math.floor(state.requestBytes / REQUEST_BYTES_PER_SECOND) * 1000)
}

function timeoutError(
  state: AttemptState,
  now: number,
  firstByteMs: number,
  streamIdleMs: number,
  eventIdleMs: number,
) {
  const silentBytes = streamIdleMs > 0 && now >= state.lastBytesAt + streamIdleMs
  const message =
    state.phase === "headers"
      ? `provider sent no response headers within ${firstByteMs + requestAllowance(state)}ms (set MIAO_LLM_FIRST_BYTE_TIMEOUT_MS to adjust, 0 disables)`
      : silentBytes
        ? `provider sent no response bytes for ${streamIdleMs}ms (set MIAO_LLM_STREAM_IDLE_TIMEOUT_MS to adjust, 0 disables)`
        : `provider produced no stream event for ${eventIdleMs}ms (set MIAO_LLM_EVENT_IDLE_TIMEOUT_MS to adjust, 0 disables)`
  return new LLMError({
    module: "SessionFirstByteGuard",
    method: "stream",
    reason: new TransportReason({ message, kind: "Timeout" }),
  })
}

function resolve(configured: number | undefined, fallback: number, defaultValue: number) {
  const value = configured ?? fallback
  return Number.isFinite(value) && value >= 0 ? value : defaultValue
}

/** Single-deadline behavior for callers without transport activity. */
function legacyWrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, timeoutMs?: number) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const configured = timeoutMs ?? Flag.MIAO_LLM_FIRST_BYTE_TIMEOUT_MS
      const timeout = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_LLM_FIRST_BYTE_TIMEOUT_MS
      if (timeout === 0) return stream
      const received = yield* Queue.unbounded<void>()
      const watchdog = Queue.take(received).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.sync(() => TransportKeepAlive.markStale()).pipe(
              Effect.andThen(
                Effect.fail(
                  new LLMError({
                    module: "SessionFirstByteGuard",
                    method: "stream",
                    reason: new TransportReason({
                      message: `provider produced no stream event within ${timeout}ms (set MIAO_LLM_FIRST_BYTE_TIMEOUT_MS to adjust, 0 disables)`,
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
        Stream.tap(() => Effect.sync(() => Queue.offerUnsafe(received, undefined))),
        Stream.interruptWhen(watchdog),
      )
    }),
  )
}
