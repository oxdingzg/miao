import { createHistogram } from "node:perf_hooks"

// Application-handler receipt -> state update -> native output submission.
// This does not measure OS input queueing or the terminal's presentation time.
export function createInputLatency() {
  const state = createHistogram()
  const output = createHistogram()
  const pending = { received: undefined as number | undefined, updated: undefined as number | undefined }
  const counts = { receipts: 0, updates: 0, submissions: 0, coalesced: 0 }
  const last = { receivedAt: 0, updatedAt: 0, submittedAt: 0 }
  const record = (histogram: ReturnType<typeof createHistogram>, duration: number) => {
    if (duration >= 0 && Number.isFinite(duration)) histogram.record(Math.max(1, Math.round(duration * 1e6)))
  }
  const read = (histogram: ReturnType<typeof createHistogram>) => ({
    count: histogram.count,
    meanMs: histogram.count ? histogram.mean / 1e6 : null,
    p95Ms: histogram.count ? histogram.percentile(95) / 1e6 : null,
    p99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
    maxMs: histogram.count ? histogram.max / 1e6 : null,
  })
  return {
    received(at = performance.now()) {
      counts.receipts += 1
      if (pending.updated !== undefined) {
        counts.coalesced += 1
        return
      }
      pending.received = at
      last.receivedAt = at
    },
    updated(at = performance.now()) {
      counts.updates += 1
      if (pending.received === undefined) return false
      if (pending.updated === undefined) record(state, at - pending.received)
      pending.updated = at
      last.updatedAt = at
      return true
    },
    submitted(at = performance.now()) {
      if (pending.received === undefined || pending.updated === undefined) return false
      if (pending.updated !== undefined) {
        record(output, at - pending.received)
        counts.submissions += 1
        last.submittedAt = at
      }
      pending.received = undefined
      pending.updated = undefined
      return true
    },
    snapshot() {
      const value = { ...counts, last: { ...last }, handlerToState: read(state), handlerToOutput: read(output) }
      state.reset()
      output.reset()
      return value
    },
  }
}
