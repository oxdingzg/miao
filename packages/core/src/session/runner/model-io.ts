export * as SessionRunnerModelIo from "./model-io"

import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import path from "path"
import { Effect } from "effect"
import { Flag } from "../../flag/flag"
import { Global } from "../../global"

/**
 * Per-provider-turn replay log, one JSON line per turn in
 * `<data>/model-io/model-io-<sessionID>.jsonl`, enabled with `MIAO_MODEL_IO=1`.
 * It records the exact provider request (auth headers excluded) and the raw
 * stream events, so a misbehaving provider turn can be replayed outside the
 * Session. The file rotates to `.old` once it exceeds the size bound, keeping
 * the recent window bounded without a retention job.
 */

const MAX_BYTES = 16 * 1024 * 1024

export type Turn = {
  readonly sessionID: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly request: unknown
  readonly events: ReadonlyArray<unknown>
  readonly settlement: { readonly finish: string; readonly cost: number; readonly tokens: unknown } | undefined
  readonly failed: boolean
  readonly durationMs: number
  readonly ttftMs: number | undefined
}

/** Collects stream events for one turn; undefined when the log is disabled. */
export type Collector = {
  readonly events: Array<unknown>
}

export const collector = (): Collector | undefined => (Flag.MIAO_MODEL_IO ? { events: [] } : undefined)

/** Same request with the HTTP layer stripped: its headers carry credentials. */
const redactRequest = (request: unknown) => {
  if (typeof request !== "object" || request === null) return request
  const { http: _, ...rest } = request as Record<string, unknown>
  return rest
}

export const write = (dir: string) =>
  Effect.fn("SessionRunnerModelIo.write")(function* (turn: Turn) {
    yield* Effect.tryPromise(async () => {
      const line = JSON.stringify({
        type: "turn",
        time: new Date().toISOString(),
        sessionID: turn.sessionID,
        model: turn.model,
        durationMs: turn.durationMs,
        ttftMs: turn.ttftMs,
        failed: turn.failed,
        settlement: turn.settlement,
        request: redactRequest(turn.request),
        events: turn.events,
      })
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `model-io-${turn.sessionID}.jsonl`)
      try {
        if ((await stat(file)).size > MAX_BYTES) await rename(file, `${file}.old`)
      } catch {
        // A missing file is the expected first-write case.
      }
      await appendFile(file, `${line}\n`)
    }).pipe(
      // The replay log must never break a live turn.
      Effect.ignore,
    )
  })
