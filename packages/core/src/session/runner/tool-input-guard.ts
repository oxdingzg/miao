export * as SessionToolInputGuard from "./tool-input-guard"

import { Buffer } from "node:buffer"
import { Effect, Stream } from "effect"
import { InvalidProviderOutputReason, LLMError, type LLMEvent } from "@miao/llm"

/** Limits unfinished tool arguments, not tool execution or answer generation. */
export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, options?: { maxBytes?: number; timeoutMs?: number }) {
  return Stream.suspend(() => {
    const configuredBytes = options?.maxBytes ?? Number(process.env.MIAO_TOOL_INPUT_MAX_BYTES ?? 1_048_576)
    const configuredTimeout = options?.timeoutMs ?? Number(process.env.MIAO_TOOL_INPUT_TIMEOUT_MS ?? 120_000)
    const maxBytes = Number.isFinite(configuredBytes) && configuredBytes > 0 ? configuredBytes : 1_048_576
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000
    const pending = new Map<string, { name: string; bytes: number; started: number }>()
    const fail = (id: string, tool: { name: string; bytes: number; started: number }, budget: "bytes" | "time") => {
      const elapsedMs = Date.now() - tool.started
      return Effect.logWarning("session.tool.input.budget", {
        callID: id,
        name: tool.name,
        bytes: tool.bytes,
        elapsedMs,
        maxBytes,
        timeoutMs,
        budget,
      }).pipe(
        Effect.andThen(
          new LLMError({
            module: "SessionToolInputGuard",
            method: "stream",
            reason: new InvalidProviderOutputReason({
              message: `Stopped unfinished tool arguments for ${tool.name}: ${budget === "bytes" ? `${tool.bytes} bytes exceeds ${maxBytes}` : `${elapsedMs}ms exceeds ${timeoutMs}ms`}. Incomplete local calls were not dispatched. Provider-managed side effects may be unknown. Earlier completed operations are retained; do not repeat them. Adjust MIAO_TOOL_INPUT_MAX_BYTES or MIAO_TOOL_INPUT_TIMEOUT_MS for intentionally large inputs.`,
            }),
          }),
        ),
      )
    }
    const watchdog = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Math.min(500, timeoutMs))
        for (const [id, tool] of pending)
          if (Date.now() - tool.started >= timeoutMs) return yield* fail(id, tool, "time")
      }
    })
    return stream.pipe(
      Stream.tap((event) => {
        if (event.type === "tool-input-start") {
          if (!pending.has(event.id)) pending.set(event.id, { name: event.name, bytes: 0, started: Date.now() })
          return Effect.void
        }
        if (event.type === "tool-call") {
          const tool = pending.get(event.id) ?? { name: event.name, bytes: 0, started: Date.now() }
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
        const tool = pending.get(event.id) ?? { name: event.name, bytes: 0, started: Date.now() }
        tool.bytes += Buffer.byteLength(event.text)
        pending.set(event.id, tool)
        if (tool.bytes > maxBytes) return fail(event.id, tool, "bytes")
        if (Date.now() - tool.started >= timeoutMs) return fail(event.id, tool, "time")
        return Effect.void
      }),
      Stream.interruptWhen(watchdog),
    )
  })
}
