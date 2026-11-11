# Acceptance record — PERF-04 and PERF-05: a five-minute soak on two platforms

Items: `PERF-04` (#1998) and `PERF-05` (#1999). Tree: branch `test/perf04-soak-window`,
parent `origin/main` `c429cd8d18`, exported with `git archive` and built on each host.

Both items accepted their profiling work earlier and left the same sentence open: "longer
soak windows and cross-platform RSS sampling" beyond a three-second window on Linux. This
record is that window, on both platforms the product ships for.

## The harness

`crates/miao-tui/tests/idle_resources.rs` gained an opt-in window: `MIAO_SOAK_SECS`
(≥ 60) runs the same idle harness for that long and asserts what only a longer window can
show — an idle TUI does not grow, and does not add descriptors, across the whole window.
Without the variable the test skips, so CI keeps its three-second budget.

It samples the process tree's RSS and CPU (`ps`) and the descriptor count (`/proc` on
Linux, `lsof` on macOS — both paths were already in the harness).

## What ran

```
MIAO_SOAK_SECS=300 cargo test --test idle_resources a_soak_window -- --nocapture
```

| host | observed |
| --- | --- |
| Linux build host `xx04` | `PERF-04 soak: window_s=300 rss_start_kb=35484 rss_end_kb=35552 growth_kb=68 cpu_ms=4000 fds_start=15 fds_end=15` — `test result: ok`, finished in 302.10 s |
| macOS arm64 (`macmini`, Darwin 25.5.0) | `PERF-04 soak: window_s=300 rss_start_kb=19856 rss_end_kb=19904 growth_kb=48 cpu_ms=1270 fds_start=18 fds_end=18` — `test result: ok`, finished in 304.75 s |

Read as rates, an idle TUI on these hosts held **1.3 %** of one core (Linux) and **0.42 %**
(macOS) over five minutes, grew by **68 kB** and **48 kB** respectively — allocator noise
for a process that allocates at all, not a monotonic climb — and added **no descriptors**.
The assertion is the same on both: growth under 8 MiB over the window, and no descriptor
increase.

## What this closes, and what it does not

Closes the two items' shared residual: the window is 100× the CI window and it now covers
the two platforms whose platforms differ in descriptor accounting, allocator and terminal
stack.

Does not claim:

- an hours-long window. Five minutes finds a per-frame leak (the descriptor check would
  fail within a second at 60 fps) and would catch a steady per-minute climb, but a leak
  that starts only after an hour is not in this record.
- Windows sampling: the two runs are Linux and macOS.
- throughput or latency: this is an idle measurement, and its CPU share is the whole
  claim. `PERF-01` owns input latency and `PERF-03` start-up.

## Version

No `roadmap:` stamp: this tree is in no published release yet.
