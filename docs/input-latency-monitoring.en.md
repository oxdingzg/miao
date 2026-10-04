# Monitoring remediation, 2026-10-04

[中文](input-latency-monitoring.zh.md)

Implementation: `16cb4a0f7` (`perf(miao): make monitoring probes and writes asynchronous`). This fixes identified blocking paths; it does not establish the allocation source responsible for the original synchronous GC samples.

## Changes

- `ps` and `sysctl` run asynchronously, with their existing five-second timeout.
- FD enumeration and DB/WAL file stats use asynchronous filesystem operations.
- Monitor append, rotation, and startup retention cleanup use asynchronous I/O. Synchronous and asynchronous diagnostic writers share the same lease and retention policy.
- Only one sample is in flight. Overlapping timer ticks are counted as `skippedSamples`, rather than growing an unbounded queue.
- Mean/P95/P99/max and sample count are read before each histogram reset. `loopWindowMs` records the actual window length, which can differ from the nominal interval.
- `probeMs`, `isolate`, and `threadId` identify probe work and isolate ownership. RSS and process CPU still describe the whole process and must not be summed across isolates.
- Empty-window latency values are null. Histogram percentile buckets may round above the actual maximum by a small amount.

## Verification

- `packages/core`: diagnostic storage tests, **8 pass**. Includes rotation/budgets, unrelated-file preservation, and mixed synchronous/asynchronous lease exclusion.
- `packages/miao`: typecheck passed; monitor regression, **1 pass / 16 assertions**. A real child process uses deliberately slow 500ms OS probes, while main-thread heartbeats continue. The test waits for recorded samples rather than a fixed readiness sleep, and checks overlap suppression plus persisted window metrics.
- Native histogram calibration: [monitor-calibration-2026-10-04.json](monitor-calibration-2026-10-04.json), Bun 1.4.2. A deliberate 90ms pause produced an 85.766ms sampled maximum; reset returned count zero; the following idle window had a 2.018ms maximum. These are calibration observations, not keyboard latency measurements.

Reproduce the calibration in a disposable process:

```sh
bun packages/miao/script/monitor-calibration.ts
```

## Input and history instrumentation

Monitor records now include isolate-local `runtime` metrics:

- `tui.input`: monotonic handler-receipt, completed state-update, and next rendered-frame timestamps, plus windowed handler-to-state/output histograms. The renderer's frame event follows native output submission. Coalesced edits use the oldest edited receipt in that frame. Counters are cumulative; histograms reset on sampling. These measurements exclude OS input queueing and terminal presentation time, and do not retain input text.
- `tui.sync`: hydration count and elapsed time (including requests), current render-node count, in-flight hydrations, and per-session message/part/UTF-16 text-unit/older-message counts. These describe retained application data, not heap allocation ownership or exact bytes.
- `core.history`: cache reuse/reload and decoded-row counters, with live database/session/entry counts. Weak references allow the metrics registry to observe caches without keeping database caches alive.

Repeated busy status events now update status without scheduling history hydration. A busy-to-idle transition still schedules a settlement refresh. Text and other transcript events retain their existing refresh behavior.

Verification: Core, TUI, and miao typechecks passed. Input timing, transcript conversion, prompt receipt and status-heartbeat regressions: **19 pass / 73 assertions**. Diagnostic reader lifetime/failure isolation: **2 pass**. History projection: **8 pass**. Monitor responsiveness: **1 pass**. The mounted status test verifies ten busy heartbeats produce no extra context request, then an idle transition produces one settlement refresh.

## Still required

Real input/state/output correlation under controlled workloads, allocation attribution, fixed-workload long-session comparisons, and 30–60 minute lifecycle/memory observations remain pending. No P95/P99 input-echo improvement, leak fix, or GPU attribution is claimed. Original captures and their manifest remain unchanged.
