# Session Messaging (inter-session conversation)

## Goal

Let one Session send a message to another Session, so agents can coordinate — a
`SendMessage`-style capability like Claude Code's. This is a harness feature, not a model
capability: the runtime owns session discovery and delivery, and exposes one tool the model calls.

## Why it fits V2 already

V2 has the substrate: durable per-session `session_input` inbox, `SessionExecution.wake`, the
`SessionRunCoordinator`, and session-scoped tool registration (`specs/v2/session-scoped-tools.md`).
Messaging is "admit a synthetic input into another Session, then wake it".

## Design

- **Tool**: a session-scoped `send_message` tool (`{ to, message }`) registered by the runner, like
  `task`. `to` is a Session ID or a short handle (`@name`), resolved through a session registry.
- **Delivery**: resolve the target Session, then `SessionInput.admit` a synthetic message
  (`delivery: "queue"`) tagged with the sender, and `SessionExecution.wake(target)`. The target's
  next turn sees it as a `<message from session=…>` system/synthetic message. If the target is not
  running, the durable inbox holds it until it resumes.
- **Discovery**: a `list_sessions` (or handle registry) so a sender can find peers; the same
  registry backs `@name` resolution. Reuse the existing `session.list` / `session.children`.
- **Direction**: parent→child, child→parent, and peer→peer within the same project. Cross-project
  messaging denied by default.
- **Bounds**: permission action `message` (allow/ask/deny per target), a per-Session inbound queue
  cap, and cost accounting so a messaging loop cannot run away (reuse the `loop` guards for the
  receiving drain).

## Wake seam (implemented)

`SessionExecution.wake` lives on the process-global execution service, which depends on the
per-Location runner (`LocationServiceMap` → `SessionRunner`). A runner-owned tool therefore cannot
depend on `SessionExecution` directly: the location → global → location edge would cycle, and an
unbound global node cannot be resolved inside the lazily-built location graph. Waking on every
`PromptAdmitted` is also wrong, because `prompt` with `resume: false` deliberately admits without
running.

Instead the runner receives the wake capability as a callback:

- `SessionRunner.run` accepts an optional `wake?: (sessionID) => Effect<void>`.
- `SessionExecutionLocal`'s drain passes `coordinator.wake`.
- `runSendMessage` admits a queued input to the target and calls `wake` when present; callers that
  only record durable input omit it and the message is delivered on the target's next drain.

Only explicit messaging wakes a peer, so `resume: false` semantics are unchanged.

## Non-goals

- No cross-machine/cluster routing yet (process-local drains only, matching the V2 execution model).
- No free-form broadcast; delivery is explicit and addressed.

## Acceptance

- A parent Session sends a message to a child (and vice versa); the receiver's transcript shows the
  message attributed to the sender, and the receiver continues.
- A message to an idle Session is delivered on its next drain; to a missing Session it fails clearly.
- Permission rule denies cross-project targets.

## Status

Landed: the session-scoped `send_message` tool (`{ to, message }`) resolves a Session ID or an
`@slug` handle within the sender's project, rejects a missing target or a target in another
project, refuses to exceed the per-Session inbound queue cap (`MAX_INBOUND_QUEUE`), admits a queued
input attributed as `<message from session="…">`, and wakes the target through the runner's `wake`
callback. The companion `list_sessions` tool enumerates sibling Sessions in the project so a
sender can discover an `@slug` target. Covered by `packages/core/test/session-runner.test.ts`.

Still open: the `message` permission action and loop-guard cost accounting for a receiving drain.
