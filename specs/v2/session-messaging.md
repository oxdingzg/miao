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

## Non-goals

- No cross-machine/cluster routing yet (process-local drains only, matching the V2 execution model).
- No free-form broadcast; delivery is explicit and addressed.

## Acceptance

- A parent Session sends a message to a child (and vice versa); the receiver's transcript shows the
  message attributed to the sender, and the receiver continues.
- A message to an idle Session is delivered on its next drain; to a missing Session it fails clearly.
- Permission rule denies cross-project targets.

## Status

Not started. Depends on the V2 cutover (Stage 4) for the interactive path, but the core pieces
(admit + wake + session-scoped tool) already exist.
