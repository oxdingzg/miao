# Context history validation

The context tab reads settled provider-step facts from the paged usage-history API. It keeps cache read/write separate from uncached input, preserves unknown windows, labels current-catalog limits separately from recorded request budgets, and draws independent scales across model/window changes. Recorded compaction messages mark the corresponding time intervals.

## Correctness

The focused context suites pass 13 tests. The browser smoke test passes retry after a failed request, chronological older-page loading, keyboard selection, and TTFT rendering. An asynchronous history request uses an explicit local loading state and cancellation, so it does not suspend or replace the Session page. The context tab initializes its content projection before breakdown computation, including when completed messages are already loaded at mount.

## Production navigation comparison

Both runs use the production build and the existing `first-navigation-benchmark.spec.ts` unvisited-session scenario on the same build host. Raw records are in `before.json` and `after.json`.

| Metric | Before | After |
| --- | --- | --- |
| First destination observed | 33.2 ms | 20.3 ms |
| Stable destination observed | 47.2 ms | 58.0 ms |
| Blank samples | 0 | 0 |
| Unknown samples | 0 | 0 |

These are single-run diagnostics, not a statistically established speedup or regression. They verify that the scenario completes and retains the no-blank-frame behavior. The context chart is mounted only when the context tab is open; this comparison does not measure chart rendering under thousands of steps.

## Existing harness limits

The old streaming benchmark still emits retired `message.part.*` live events, so it fails to produce its expected text before these UI changes. The separate e2e typecheck also has pre-existing errors in `performance/timeline-stability/fixture.ts` and its test (legacy events and encoded/decoded message types). The production app typecheck passes. Neither harness issue is represented as a passing streaming or full-e2e typecheck result.
