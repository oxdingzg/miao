# Native product delegation acceptance (2026-10-24)

## Version boundary

This acceptance uses a real TUI started from a **source trial**, local commit
`fd0238d8ff70fdf3c95c0e9131fdc3b714b8283d`, composed from the verified changes
in #1312, #1317, #1318 and #1319. The native engine executable is the published
0.2.26 darwin-arm64 artifact (SHA-256 in the accompanying JSON). This is **not**
a claim that the published 0.2.26 host already includes these later fixes.

The isolated workspace contains only the needed API credential and uses
`deepseek/deepseek-v4-flash`. No production Session database or OAuth login
state is copied or modified. The TUI is driven through a real PTY using tmux;
its footer identifies the native runtime. `workflow`, not the engine-internal
`task` tool, creates first-class product child Sessions.

## Child rendering and accounting

A workflow step calls `tools.workflow.agent` with the `explore` agent and asks
it to reply `CHILD-ACCEPTANCE-OK` without tools. The product TUI renders the
workflow tool result and the returned child Session ID/text. The child is a
persisted `session` row with `parent_id` pointing to the visible parent.

Snapshot after successful completion, before the separate cancellation run:

| Accounting value | Product reference cost |
| --- | --- |
| Parent's own turn facts | $0.000251250 |
| Child's own turn facts and `session.cost` | $0.000065616 |
| Parent's aggregate `session.cost` | $0.000316866 |

The parent total is exactly its own facts plus the child's cost. This is
reference-price accounting, not a provider invoice. The JSON records the
successful run's terminal timestamp so its fact sums can be distinguished
from subsequent work in the same parent Session.

## Parent interruption cancels the active child

A second workflow step asks an `explore` child to produce a long answer with
no tools. A read-only observer waits for that child's durable
`provider.started` event (sequence 9), then sends Escape to the real parent
TUI. No child shell permissions are needed or bypassed.

Both Sessions settle as interrupted:

| Session | Event | Sequence | Reason |
| --- | --- | --- | --- |
| Parent | `run.finished` | 48 | `interrupted` |
| Parent | `stop` | 49 | `interrupted` |
| Child | `run.finished` | 13 | `interrupted` |
| Child | `stop` | 14 | `interrupted` |

`delegation-acceptance-2026-10-24.json` contains the selected terminal events
and numeric accounting snapshot. It excludes prompts, request bodies,
credential values, and private machine configuration.

## Defects exposed and fixed by this acceptance

- #1312: product tool preparation lacked scoped services, hiding `workflow`.
- #1317: SessionCreate did not start its projector; no product child row was
  created even though the creation event was published.
- #1318: older engine usage can omit the model while recording authoritative
  identity at `provider.started`; pricing now uses only the matching run/step.
- #1319: native facts did not update Session/ancestor aggregates. Their fact
  insertion and aggregate propagation are now atomic and replay-idempotent.

Earlier shell-based cancellation attempts did not dispatch because policy
refused the command, and earlier observer attempts did not establish a new
active child. Those attempts are not counted as cancellation evidence.
