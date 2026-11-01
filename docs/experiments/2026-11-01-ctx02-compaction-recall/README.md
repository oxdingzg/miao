# CTX-02: automatic compaction prunes, and `recall` still reaches what it pruned

Measured 2026-11-01 on this workstation against a real provider
(`opencode-go/deepseek-v4.1-flash`), with the native engine placed explicitly
(`--engine native`, `MIAO_ENGINE_STORAGE=/tmp/ctx02/storage`).

## Setup

Automatic compaction is off unless a limit is configured, so the run set one
small enough to cross the trigger inside a single task:

```sh
MIAO_CONTEXT_LIMITS='{"window":9000,"ratio":0.5,"headroom":800,"perPass":2}' \
MIAO_ENGINE_STORAGE=/tmp/ctx02/storage \
miao-dev run --engine native -m opencode-go/deepseek-v4.1-flash --format json \
  'REFERENCE-TOKEN: ZEBRA-4271. Create notes/part-1.md through notes/part-6.md,
   each with 120 numbered lines (line N of part K). Then read each file back with
   the read tool, one file at a time, and report the line count for each.'
```

The task writes six files and reads them back, which is enough content to cross
a 9 000-token window at a 0.5 ratio.

## Result 1 — the trigger fired and pruned

The engine's own ledger records the compaction:

```sql
SELECT id, session_id, through_seq, length(summary), created_seq FROM engine_compaction;
cut_0ba2398f-…_120 | ses_gfe5e6b34f97effeIbPQedd02f | 120 | 4759 | 141
```

One compaction, a 4 759-character summary, a boundary at message 120, in a
session of 145 events. Cost of the driving turn: 9 steps, **$0.004374**
(168 755 input tokens of which 147 968 were cache reads, 1 354 output).

## Result 2 — the pruned original is still recoverable

A second turn in the same Session asked the agent to run `recall` for the marker
that only appeared in the first user message, which is behind the boundary:

```
recall query "ZEBRA-4271"  status: completed
matches: message_seq 160 (assistant), 149 (user), 6 (user)
scanned_messages: 20   exhausted: true
```

`message_seq 6` is the original prompt:

> REFERENCE-TOKEN: ZEBRA-4271. Create notes/part-1.md through notes/part-6.md …

So the compaction summarised the window but did not destroy it: the raw message
is still addressable after pruning, which is the second acceptance bullet of
CTX-02. Cost of the verification turn: 2 steps, **$0.002201**.

Total spend for this evidence: **$0.006575**.

## What this does not cover

- One sample, one compaction event, one model. It proves the mechanism and its
  recoverability, not a quality or cost distribution across long tasks; that
  needs repeated samples (VAL-01's harness) and is a separate acceptance step.
- `recall` was exercised by asking the agent to call it. A direct engine-level
  call would remove the model from the loop, but would not test the path a
  session actually takes.
