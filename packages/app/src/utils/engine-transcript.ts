import type { EngineEvent } from "@miao/client/engine"

/**
 * One row of the read-only transcript: the engine's committed event, reduced to
 * what a list can render. This is not the app's message view model — that one
 * needs the V2 projection, which is a separate concern.
 */
export type TranscriptRow = {
  seq: number
  kind: string
  summary: string
}

/**
 * Append a page or live batch to the transcript.
 *
 * The engine orders events by `seq` and the reader both replays a page and
 * follows the live stream, so the same committed event can arrive twice. A row
 * at or below the last seq is therefore dropped rather than rendered again.
 */
export function appendEvents(rows: ReadonlyArray<TranscriptRow>, events: ReadonlyArray<EngineEvent>): TranscriptRow[] {
  const next = [...rows]
  let last = next.at(-1)?.seq ?? 0
  for (const event of events) {
    if (event.seq <= last) continue
    last = event.seq
    next.push({ seq: event.seq, kind: event.kind, summary: summarizeEvent(event) })
  }
  return next
}

/** A bounded, single-line description of an event's payload. */
export function summarizeEvent(event: EngineEvent): string {
  const data = event.data
  if (typeof data === "string") return clip(data)
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>
    for (const key of ["title", "text", "delta", "command", "path", "tool", "reason"]) {
      const value = record[key]
      if (typeof value === "string" && value) return clip(value)
    }
  }
  return ""
}

function clip(value: string) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}
