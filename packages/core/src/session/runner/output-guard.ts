export * as SessionOutputGuard from "./output-guard"

import { Effect, Stream } from "effect"
import { InvalidProviderOutputReason, LLMError, type LLMEvent } from "@miao/llm"

const WINDOW_LINES = 64
const MAX_LINE = 160
const MAX_PARTS = 16

export const ERROR_PREFIX = "Stopped repetitive"
export const NEUTRALIZED =
  "[Removed from model context: repetitive output from an earlier assistant turn. Any recorded tool calls and their results are retained; do not repeat completed side effects.]"

/** Also detects historical loops without rewriting their durable transcripts. */
export function detect(text: string) {
  return make()({ type: "text-delta", id: "history", text }) !== undefined
}

/** A conservative guard for repetitive, short prose lines, not tool-call repetition. */
export function make() {
  const parts = new Map<string, { pending: string; oversized: boolean; fenced: boolean; lines: string[] }>()

  return (event: LLMEvent) => {
    if (event.type === "step-start" || event.type === "finish") {
      parts.clear()
      return
    }
    if (
      event.type === "text-start" ||
      event.type === "reasoning-start" ||
      event.type === "text-end" ||
      event.type === "reasoning-end"
    ) {
      parts.delete(`${event.type.startsWith("text-") ? "text" : "reasoning"}:${event.id}`)
      return
    }
    if (event.type !== "text-delta" && event.type !== "reasoning-delta") return
    const channel = event.type === "text-delta" ? "text" : "reasoning"
    const key = `${channel}:${event.id}`
    const state = parts.get(key) ?? { pending: "", oversized: false, fenced: false, lines: [] }
    if (!parts.has(key) && parts.size >= MAX_PARTS) {
      const oldest = parts.keys().next().value
      if (oldest !== undefined) parts.delete(oldest)
    }
    parts.set(key, state)

    // Process incrementally so a giant delta cannot grow our retained text, and
    // token/chunk boundaries cannot change detection. Blank lines do not break
    // a prose loop; code fences, long lines and structured output do.
    for (const character of event.text) {
      if (character !== "\n") {
        if (state.oversized) continue
        state.pending += character
        if (state.pending.length > MAX_LINE) {
          state.pending = ""
          state.oversized = true
          state.lines = []
        }
        continue
      }
      const line = state.pending.trim().toLowerCase()
      state.pending = ""
      if (state.oversized) {
        state.oversized = false
        continue
      }
      if (/^(?:```|~~~)/u.test(line)) {
        state.fenced = !state.fenced
        state.lines = []
        continue
      }
      if (state.fenced || !line) continue
      // Exclude code, JSON, tables, numbered lists and punctuation-only art.
      if (/^[-*+]\s/u.test(line) || !/\p{L}/u.test(line) || !/^[\p{L}\p{M}\s.,!?…。！？，、()（）'’"-]+$/u.test(line)) {
        state.lines = []
        continue
      }
      state.lines.push(line)
      if (state.lines.length > WINDOW_LINES) state.lines.shift()
      if (state.lines.length !== WINDOW_LINES) continue
      const counts = new Map<string, number>()
      state.lines.forEach((text) => counts.set(text, (counts.get(text) ?? 0) + 1))
      const ranked = [...counts.values()].toSorted((a, b) => b - a)
      if (counts.size > 6 || (ranked[0] ?? 0) + (ranked[1] ?? 0) < 58) continue
      return channel
    }
  }
}

/** Scoped to one stream subscription/attempt; the error is deliberately non-retryable. */
export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>) {
  return Stream.suspend(() => {
    const observe = make()
    return stream.pipe(
      Stream.tap((event) => {
        const channel = observe(event)
        if (!channel) return Effect.void
        return Effect.logWarning("session.output.repetition", { channel, windowLines: WINDOW_LINES }).pipe(
          Effect.andThen(
            new LLMError({
              module: "SessionOutputGuard",
              method: "stream",
              reason: new InvalidProviderOutputReason({
                message: `Stopped repetitive ${channel} output. This turn was not retried; earlier tool changes may already have completed. Compact the session or switch models before continuing.`,
              }),
            }),
          ),
        )
      }),
    )
  })
}
