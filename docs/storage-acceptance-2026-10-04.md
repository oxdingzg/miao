# Storage acceptance, 2026-10-04

## Current database

The release-managed `miao` 0.1.2 reported WAL mode, incremental auto-vacuum mode `2`, approximately 751.8 MB, and no free pages. `miao db compact --dry-run` reported zero aggregate sequences requiring restart. The legacy `message` and `part` tables are already absent.

An online SQLite backup was created under the local miao `backups` directory with owner-only file permissions. Its `PRAGMA quick_check` result was `ok`:

| Table | Rows in the snapshot |
| --- | ---: |
| session | 161 |
| session_message | 22,908 |
| session_input | 575 |
| event | 108,887 |
| credential | 4 |

The counts describe one consistent snapshot; the running database continues to receive new events.

## Restore acceptance

The actual release binary's `miao db restore --merge-from ...` command was run against a separate copy of the accepted snapshot. The merge inserted zero duplicate rows. Afterwards:

- `PRAGMA quick_check` was `ok`.
- Row-content digests matched the source for `session`, `session_message`, `session_input`, `event`, `event_sequence`, `credential`, `todo`, and `session_context_epoch`.
- The live database was not used as the restore target.

Core compaction, restore, auto-backfill, and session-compaction regressions passed: **22 tests / 72 assertions**. These include synthetic cases beyond the idempotent full-snapshot CLI acceptance above.

## Observation

The accepted backup and merge-verification copy are retained. Recovery acceptance is complete for this snapshot; the observation period remains open. No backup deletion or additional live compaction was performed as part of this check.
