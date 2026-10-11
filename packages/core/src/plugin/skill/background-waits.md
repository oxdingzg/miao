<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (V2) and packages/miao/src/skill/index.ts
  (V1). The body below becomes the skill's content.
-->

# Background waits

A foreground command that waits — `--watch`, `watch`, `tail -f`, a
`while`/`sleep` polling loop, a CI or release run — holds the turn until its
timeout and reads as a stuck session. Never hold the turn. Start the wait in
the background and record which task depends on it. Continue any independent
runnable task while the external process runs. End the turn only when no
runnable task remains; its completion notification resumes dependent work.

## Never hold the turn

- Run open-ended commands with `run_in_background` (bash), or the `monitor`
  tool for waits that can outlive ten minutes. A waiting job does not make the
  entire Session idle: continue independent authorized work in the same Session.
- Mark the dependent todo `waiting`, with its job or run identity in the content.
  Keep ready tasks `pending` or `in_progress`; use `blocked` for a missing decision.
  Starting a watcher is not a reason to suspend unrelated tasks.
- `job_wait` and foreground polling are still blocking. Only reap jobs you
  expect to finish within seconds; let everything else wake you.
- Set explicit timeouts on background jobs: a default-timeout job can be
  killed mid-run and its watch lost with it.

## One notification, not a stream

- Filter monitor notifications to the final verdict line (the `pattern`
  parameter), so exactly one notice arrives and it carries the answer.
- Before ending the turn, say what is running, roughly how long it takes, and
  what happens when it finishes.

## GitHub: watch the run, not the checks list

- `gh pr checks --watch` exits 0 as soon as every check it can already see has
  finished. Right after a push, a fresh run's jobs are not registered yet, so
  it can report "all passed" before the run even starts — a false green that
  invites a premature merge.
- Resolve the run id and watch the run itself:
  `gh run list --workflow <wf> --branch <branch> --limit 1 --json databaseId`,
  then `gh run watch <id> --exit-status`, or poll
  `gh run view <id> --json status` until `status == "completed"` and report
  `conclusion`.
- Confirm the run exists before watching: a watcher that starts first sees an
  empty list and can conclude anything.

## The general pattern

- Reduce every long wait to a durable handle — a run id, a job id, a URL — and
  wait on that handle's terminal state, never on a snapshot of currently
  visible items.
- After starting a background wait, continue independent runnable tasks. End
  the turn only when all remaining tasks are waiting, blocked, or complete.
  Notifications drive waiting tasks; the Session need not sit idle while other
  authorized work can proceed.
