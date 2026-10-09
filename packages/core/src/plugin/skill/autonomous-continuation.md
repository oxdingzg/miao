# Autonomous continuation

A pattern for engagements the user has explicitly authorized to keep running
on their own until a stated objective is complete: overnight implementation
runs, long batch migrations, unattended verification passes. This skill
changes how the session schedules itself across idle periods. It grants no
authority by itself — every engagement's boundaries (no push, no PRs, no
subagents, what counts as done) come from that engagement's instructions, and
the newest user instruction always wins.

## Self-renewal, not a fixed loop

- Do not create a recurring cron job that fires on a fixed interval. A wake
  schedules at most one successor with `schedule_wakeup`, and only if work
  remains. Fixed-interval heartbeats pile up duplicate prompts while the
  session is busy and fire pointlessly while it waits on notifications.
- Renewal interval follows progress: 20-60 minutes across a pure work gap.
  When a remote build, test suite, or CI run is in flight, schedule nothing
  short — the background job's completion notification is the driver (see the
  background-waits skill).
- Keep one pending renewal at a time. Replacing a stale wake is fine; stacking
  several is not.

## Heartbeats deduplicate

- A backlog of identical wake prompts (left by earlier scheduling or a
  restart) is one heartbeat: re-read the durable goal/todo state, do a light
  status check, and continue the oldest unfinished unit.
- Never start a second monitor for a check that is already running, and never
  duplicate a commit for an already-landed unit.

## Every wake

1. Read the durable goal/todo state before doing anything else.
2. Continue the oldest unfinished unit. Verify (tests, checks, review the
   diff) before marking anything done; unverified work stays open.
3. Commit each verified unit promptly with a conventional commit message.
   Report status accurately: built is not committed, committed is not pushed.
4. Treat scheduled notifications as steering, not as a task replacement.
5. If a unit is blocked, record the blocker in the durable state, leave the
   task open, and let the next wake re-evaluate. Do not mark blocked work
   completed to close the loop.

## Stopping

- When the objective is complete: stop renewing, delete any recurring jobs,
  cancel pending wakes, and summarize what was delivered and what was left
  uncovered. Leave no resident tasks behind.
- Never renew past the engagement's stated boundary. If the next step would
  exceed it (push, publish, merge, spending beyond a stated budget), stop and
  surface the decision instead of proceeding.
