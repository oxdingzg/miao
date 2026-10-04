import { monitorEventLoopDelay } from "node:perf_hooks"

const histogram = monitorEventLoopDelay({ resolution: 20 })
const read = () => ({
  count: histogram.count,
  meanMs: histogram.mean / 1e6,
  p95Ms: histogram.percentile(95) / 1e6,
  p99Ms: histogram.percentile(99) / 1e6,
  maxMs: histogram.max / 1e6,
})

histogram.enable()
await Bun.sleep(100)
// A deliberate calibration pause in this disposable process, not a GC policy.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90)
await Bun.sleep(80)
const blocked = read()
histogram.reset()
const reset = read()
await Bun.sleep(100)
const idle = read()
histogram.disable()
console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, resolutionMs: 20, deliberatePauseMs: 90, blocked, reset, idle }, null, 2))
