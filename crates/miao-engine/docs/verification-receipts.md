# Completion-check receipts

The opt-in completion command (`--verify-command`, or integrated global `engine.verify_command`)
now records an attempt as `verification.started` and `verification.completed`. Each receipt includes
its command, run/attempt, wall-clock timestamps, bounded actual process result (including exit code
and stdout/stderr), source snapshots and goal/todo revisions. `verification.passed` and
`verification.failed` reference the completed receipt with `receipt_seq`.

A zero exit is accepted only when the tracked source snapshots are complete and unchanged, the
recorded task revisions are unchanged, and the attempt was not cancelled. An exit-zero command that
rewrites a tracked source file therefore requires a fresh check against the new content. Existing
repair allowance remains bounded: one repair continuation, then classified failure. Cancellation
records an unaccepted receipt and does not admit a new repair prompt. Failure feedback is truncated
on Unicode character boundaries.

## Source coverage

The bounded scope is explicitly `native-write-targets`, not a whole-repository or Git revision:

- Native write/edit/patch targets dispatched during this run are retained in deterministic order.
- At most 128 paths and 1 MiB per regular file are fingerprinted through the contained workspace
  directory capability; missing/deleted files have an explicit state.
- Truncated or unreadable tracked scopes are incomplete and cannot validate a passing attempt.
- Process, background and extension calls mark `untracked_writers`: their full write footprint is
  unknown. Other files and external task activity are outside this manifest's coverage.

Snapshots are observations around the command; they cannot prevent subsequent external writes or
prove that every file was simultaneously immutable. A receipt proves the recorded check against its
stated source/task scope. It does not establish untested semantic acceptance criteria, assert hidden
artifact coverage, or automatically mark the user's entire objective done. Configured commands may
name artifact references in their output, which the bounded result retains.
