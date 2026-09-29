# Session-Scoped Tools

## Status (2026-09-29)

Landed. The registry gained a session scope (application < location < session) via
`ToolRegistry.registerSession(sessionID, tools)` and `materialize(permissions, { sessionID })`. The
runner opens the registration for the duration of a drain and registers the `task` subagent tool
when the Session's agent is known. `SessionV2.create` gained an internal `parentID`, and session
creation was extracted to `SessionCreate` so the runner can create child Sessions. The `task` tool
runs end to end in `packages/core/test/session-runner.test.ts`.

Verified: `packages/core` full suite (1130 tests) green; core/miao/server typecheck pass.

## Original blocker (2026-09-29)

A Location tool could not depend on the global `SessionV2` / `SessionExecution` services without a
tag-dependency cycle (`SessionV2 → SessionExecution → LocationServiceMap → location services →
BuiltInTools → TaskTool → SessionV2`). The session scope above breaks it by injecting the
capability through the runner instead of through construction.

## Problem

V2 has two registration scopes today (`packages/core/src/tool/AGENTS.md`):

- **Application** (`ApplicationTools.Service`) — process-wide.
- **Location** (`ToolRegistry.Service`) — per workspace directory.

Built-in tools are Location leaves. They acquire their dependencies (filesystem, permission,
shell, search) while the Location layer is constructed and capture them in the executor closure.

Some tools need the Session they are invoked in, not just the Location:

- `task` — create a child Session, admit a prompt, run it to completion, read its report.
- MCP tools — a connection/session per Session, with per-Session auth and cancellation.
- Plugin tools — plugin instances and hooks scoped to the Session.
- Structured-output tools — a per-Session schema and an admission channel back into the runner.

A Location tool cannot acquire any of these at construction, because the Session/graph services
are downstream of the Location graph. Passing the whole `SessionV2` service into the Location
layer is not possible without the cycle above.

## Design: add a session registration scope

Extend the registry to a third scope tier, session-scoped, registered by the runner around a
drain:

- **Precedence**: application < location < session. The latest active same-placement
  registration wins, exactly like the existing tiers.
- **Registration**: the runner (which already owns the Location-scoped `SessionRunner` and the
  Session identity) registers session-scoped canonical tools through the same
  `ToolRegistry.Service.register({ name: tool })` surface, opened in a scope tied to the drain
  and closed when the drain ends. No new public `Tool.make` variant; session tools are ordinary
  canonical tools whose `execute` closes over the session services the runner provides.
- **Materialization**: `ToolRegistry.materialize` overlays sessions scoped registrations for the
  current Session over location and application registrations, then derives definitions and
  settles through the same path.
- **Identity**: a session registration carries the owning `Session.ID`; the registry only exposes
  it while that Session's drain is active in this process, matching the process-local execution
  model in `CONTEXT.md`.

This keeps tools as canonical leaves, keeps the registry the single execution boundary, and
avoids widening `Tool.Context` with an opaque capability bag.

## Consequences

- The runner becomes the owner of session-scoped registration lifecycle (open on drain start,
  close on drain end), mirroring how it already owns drain-scoped state.
- MCP and plugin registration design can build on this tier instead of inventing a parallel
  path, satisfying the "explicit canonical registration design" the tool AGENTS.md asks for.
- `task` can be implemented as a session-scoped canonical tool: create the child with
  `SessionV2.create({ parentID })`, admit with `SessionV2.prompt`, join with
  `SessionExecution.resume`, then read the child's projected history.

## Alternatives considered

- **Inject capabilities through `Tool.Context`**: the runner passes a session capability bag into
  settlement. Rejected as the primary design because it widens the tool boundary with an implicit
  service locator and does not match the registry-as-single-boundary principle. May still be used
  narrowly for a single opaque handle (for example a structured-output admission channel) if the
  session tier proves too coarse.
- **Session-shaped Location services**: rejected; Location layers are keyed by directory, not by
  Session, so they cannot carry per-Session state.

## Acceptance

- A session-scoped tool is visible only while its owning Session drain is active in the process.
- Location and application registrations still win/lose exactly as documented once a session
  registration is present.
- `task` is implemented and tested end to end: parent turn calls `task`, a child Session runs,
  the child's final assistant text is returned to the parent, and nested `task` calls are
  rejected.
- Closing a drain removes its session registrations without affecting other sessions.
