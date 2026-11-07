# Acceptance record — PERF-02 projection avoids scanning the event log per message

Item: `PERF-02`. Tree: `main` at `c13275e9a6` (`#2676`). Commands ran on the
Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-engine/` at
that tree.

## The criterion this record accepts

**Snapshot generation and projection do not scan the entire event log
message-by-message.** The projection reads each Session's identity journal once
(`assistant_profiles`, `crates/miao-engine/src/store.rs`) and then reads the
messages from the write-time-projected `engine_message` table with an indexed,
cursor-bounded query. The code carries the measurement that motivated it: the
previous shape looked each message's identity up separately and scanned every
event of the Session per message — 1,124 messages over 7,227 events took
2.8 s, and every TUI re-hydration paid it again. That scan is gone; what
remains is one journal read plus one table read.

## Suites

| what | command | observed |
| --- | --- | --- |
| snapshot and fork preserve history beyond a thousand messages | `cargo test --test long_history` (from `crates/miao-engine/`) | `1 passed; 0 failed`, 17.5 s |

## What this record does not claim

- The projection still serializes a whole Session for a snapshot or fork; the
  bound that exists (64 MB / 20 000 messages) stops runaway payloads, it does
  not cap legitimate large Sessions.
- No benchmark ratio is claimed here beyond the fixed quadratic the code
  records; the frame-budget criterion of this item was accepted previously.
