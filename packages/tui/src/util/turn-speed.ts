import type { AssistantMessage } from "@miao/schema/view-models"

/**
 * How fast a turn produced its output. The span runs from the request being
 * issued to it completing, so it covers every tool call the turn made and every
 * retry it survived: a whole-turn throughput, not a generation rate. The TUI
 * has no arrival time for text parts, so a true generation rate would need the
 * runner to report one.
 */

export type TurnSpeed = {
  readonly output: number
  /** Milliseconds the whole turn took. */
  readonly duration: number
  /** Output tokens per second across that span. */
  readonly tps: number
}

export function turnSpeed(message: AssistantMessage): TurnSpeed | undefined {
  const completed = message.time.completed
  // A turn still in flight has no duration yet, and one that reported no output
  // has no rate to report either.
  if (completed === undefined || message.tokens.output <= 0) return
  const duration = completed - message.time.created
  if (duration <= 0) return
  return { output: message.tokens.output, duration, tps: message.tokens.output / (duration / 1000) }
}
