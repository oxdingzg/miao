# Diagnostic storage: implemented limits and remaining gaps

This page describes the current implementation, rather than proposed quotas.
Diagnostic artifacts are separate from Session databases, attachments and managed
tool output. Changes in source apply to newly started source or release builds;
already-running binaries retain their existing behavior.

## Current behavior

| Artifact                                 | Implemented size/count policy                                                                   | Cleanup                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Ordinary `miao.log`                      | 5 MiB per file, 15 MiB combined budget, at most three managed files (`miao.log` and `.previous`) | Rotation on write through the shared diagnostic lease; managed-file age cleanup uses a seven-day cutoff |
| TUI theme `tui.log`                      | 1 MiB per file, 2 MiB combined budget, at most two managed files (`tui.log` and `.previous`)    | Rotation on write; managed-file age cleanup uses a seven-day cutoff |
| `log/monitor/` resource samples          | 1 MiB per file, 32 MiB directory budget, at most 64 managed files including `.previous` backups | Seven-day cutoff; startup cleanup runs even with `MIAO_MONITOR=0`   |
| Provider wire archive (opt-in)           | Rotation threshold of 32 MiB per file; no aggregate byte or file-count quota                    | Files older than two days pruned at startup and rotation            |
| Automatic `heap-*.heapsnapshot` (opt-in) | Capture triggers above 2 GiB RSS; at most four snapshots and 2 GiB combined                      | Pruned after each capture with the shared seven-day cutoff          |

There is therefore **no fixed total diagnostic-storage ceiling**. In particular,
the 2 GiB heap trigger is a process-memory threshold, not a snapshot disk quota.
Heap snapshots were the last artifact without a budget; provider wire archives
remain aggregate-unbounded within their two-day retention window.

## Bounded stores

`DiagnosticFiles` serializes theme/monitor retention checks and writes with a
cross-process lease. Rotation occurs before a managed file exceeds its write
limit. Oversized individual records are dropped. Old managed files are removed
to satisfy directory byte and file-count budgets, with directory byte budgets
taking precedence over retaining a full historical window.

Only explicitly matched regular files are selected for cleanup. A busy lease or
filesystem error drops a diagnostic write rather than failing an agent turn.
A crashed writer's lease can be recovered.

Resource samples are normally recorded every 30 seconds. Thread/swap probes run
less often, and samples/writes are asynchronous to avoid blocking input handling.

## Optional capture

Provider wire capture is enabled with `MIAO_LLM_WIRE_ARCHIVE`. `1` or `true` uses
`log/provider-wire`; another non-empty value selects a directory. Captured bodies
and frames are bounded and redacted by the archive code, but per-file rotation
and age cleanup do not enforce a total directory budget.

Automatic heap capture is enabled with `MIAO_AUTO_HEAP_SNAPSHOT`. It invokes
`node:v8.writeHeapSnapshot` when RSS exceeds 2 GiB, rearms after RSS falls below
that threshold, and suppresses capture errors. This does not guarantee bounded
snapshot disk usage or support on every runtime. Manually generated snapshots
are also outside the theme/monitor budgets.

## Remaining implementation work

- Add a defined rotation/retention policy to the ordinary file logger.
- Add an aggregate byte/file-count budget to provider wire archives.
- Design and implement bounded heap capture on the supported runtime before
  advertising snapshot size limits. A stream-limiter prototype alone is not a
  working heap capture path.

These are implementation gaps, not limits users can currently enable through
configuration. None of these cleanup policies applies to Session databases or
attachments.

## Source references

- `packages/core/src/diagnostic-files.ts`: leases, matching, rotation and quotas.
- `packages/core/src/observability/logging.ts`: ordinary file logger.
- `packages/miao/src/cli/monitor.ts`: monitor budget and startup cleanup.
- `packages/tui/src/context/theme.tsx`: theme log budget.
- `packages/core/src/provider-wire-archive.ts`: wire rotation and age cleanup.
- `packages/miao/src/cli/heap.ts`: opt-in heap capture.
