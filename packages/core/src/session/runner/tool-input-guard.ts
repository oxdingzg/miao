export * as SessionToolInputGuard from "./tool-input-guard"

import { Buffer } from "node:buffer"
import { Clock, Effect, Stream } from "effect"
import { InvalidProviderOutputReason, LLMError, type LLMEvent } from "@miao/llm"

/** Bounds argument size and per-call inactivity, not ongoing generation or tool execution. */
export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, options?: { maxBytes?: number; timeoutMs?: number }) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const configuredBytes = options?.maxBytes ?? Number(process.env.MIAO_TOOL_INPUT_MAX_BYTES ?? 1_048_576)
      const configuredTimeout = options?.timeoutMs ?? Number(process.env.MIAO_TOOL_INPUT_TIMEOUT_MS ?? 120_000)
      const maxBytes = Number.isFinite(configuredBytes) && configuredBytes > 0 ? configuredBytes : 1_048_576
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000
      const pending = new Map<string, { name: string; bytes: number; started: number; updated: number }>()
      const fail = (
        id: string,
        tool: { name: string; bytes: number; started: number; updated: number },
        budget: "bytes" | "idle",
      ) => {
        const now = clock.currentTimeMillisUnsafe()
        const elapsedMs = now - tool.started
        const idleMs = now - tool.updated
        return Effect.logWarning("session.tool.input.budget", {
          callID: id,
          name: tool.name,
          bytes: tool.bytes,
          elapsedMs,
          idleMs,
          maxBytes,
          timeoutMs,
          budget,
        }).pipe(
          Effect.andThen(
            new LLMError({
              module: "SessionToolInputGuard",
              method: "stream",
              reason: new InvalidProviderOutputReason({
                message: `Stopped unfinished tool arguments for ${tool.name}: ${budget === "bytes" ? `${tool.bytes} bytes exceeds ${maxBytes}` : `no argument progress for ${idleMs}ms (idle limit ${timeoutMs}ms; ${tool.bytes} bytes received over ${elapsedMs}ms)`}. Incomplete local calls were not executed. Earlier completed operations are retained; do not repeat them. ${budget === "bytes" ? "Split large inputs into smaller calls, or adjust MIAO_TOOL_INPUT_MAX_BYTES." : "Retry only the unfinished work. For a slow provider or gateway, adjust MIAO_TOOL_INPUT_TIMEOUT_MS (idle timeout)."} Provider-managed side effects may be unknown.`,
                // The runner replays an idle trip instead of failing the turn;
                // the byte budget is deterministic for the same input, so it
                // stays terminal.
                toolInput: { callID: id, name: tool.name, characters: tool.bytes, canCorrect: false, budget },
              }),
            }),
          ),
        )
      }
      const watchdog = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Math.min(500, timeoutMs))
          for (const [id, tool] of pending)
            if (clock.currentTimeMillisUnsafe() - tool.updated >= timeoutMs) return yield* fail(id, tool, "idle")
        }
      })
      return stream.pipe(
        Stream.tap((event) => {
          const now = clock.currentTimeMillisUnsafe()
          if (event.type === "tool-input-start") {
            if (!pending.has(event.id))
              pending.set(event.id, { name: event.name, bytes: 0, started: now, updated: now })
            return Effect.void
          }
          if (event.type === "tool-call") {
            const tool = pending.get(event.id) ?? { name: event.name, bytes: 0, started: now, updated: now }
            tool.bytes = Buffer.byteLength(JSON.stringify(event.input))
            pending.delete(event.id)
            if (!event.providerExecuted && tool.bytes > maxBytes) return fail(event.id, tool, "bytes")
            return Effect.void
          }
          if (event.type === "tool-input-end") {
            pending.delete(event.id)
            return Effect.void
          }
          if (event.type !== "tool-input-delta") return Effect.void
          const tool = pending.get(event.id) ?? { name: event.name, bytes: 0, started: now, updated: now }
          if (now - tool.updated >= timeoutMs) return fail(event.id, tool, "idle")
          tool.bytes += Buffer.byteLength(event.text)
          // Empty fragments, duplicate starts and unrelated events are not progress.
          if (event.text.length > 0) tool.updated = now
          pending.set(event.id, tool)
          if (tool.bytes > maxBytes) return fail(event.id, tool, "bytes")
          return Effect.void
        }),
        Stream.interruptWhen(watchdog),
      )
    }),
  )
}
