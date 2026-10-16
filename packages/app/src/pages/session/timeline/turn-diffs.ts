import { createSignal } from "solid-js"
import type { SummaryDiff } from "./timeline-row"

export type TurnDiffFetcher = (input: { sessionID: string; messageID: string }) => Promise<SummaryDiff[]>

const RETRY_AFTER_MS = 30_000

type Entry = { diffs?: SummaryDiff[]; failedAt?: number }

/**
 * Per-page cache for per-turn changed-file diffs. Each turn is fetched once;
 * a failed fetch is retried only after a cool-off so a flaky endpoint cannot
 * turn the timeline into a request loop.
 */
export function createTurnDiffSource(fetch: TurnDiffFetcher, options?: { retryAfterMs?: number }) {
  const retryAfterMs = options?.retryAfterMs ?? RETRY_AFTER_MS
  const entries = new Map<string, Entry>()
  const pending = new Set<string>()
  const [version, setVersion] = createSignal(0)

  const load = (sessionID: string, messageID: string) => {
    const key = `${sessionID}|${messageID}`
    if (pending.has(key)) return
    const entry = entries.get(key)
    if (entry?.diffs) return
    if (entry?.failedAt && Date.now() - entry.failedAt < retryAfterMs) return
    entries.delete(key)
    pending.add(key)
    fetch({ sessionID, messageID })
      .then((diffs) => {
        entries.set(key, { diffs })
      })
      .catch(() => {
        entries.set(key, { failedAt: Date.now() })
      })
      .finally(() => {
        pending.delete(key)
        setVersion((value) => value + 1)
      })
  }

  const get = (sessionID: string, messageID: string): SummaryDiff[] | undefined => {
    version()
    return entries.get(`${sessionID}|${messageID}`)?.diffs
  }

  return { load, get }
}
