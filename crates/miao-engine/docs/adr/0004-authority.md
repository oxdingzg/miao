# ADR-04: Authority — permission, approval and sandbox

Status: Accepted (implemented by `src/permission.rs`, `src/approval.rs`,
`src/process.rs`, `src/tools.rs`).

## Context

Model-proposed actions (file writes, process execution, extensions) must be
gated by a policy that a client cannot widen by talking to the engine, and an
approval must be bound tightly enough that a stale or replayed answer cannot
authorize a different action.

## Decision

- **Effective policy is an upper bound.** Approval can only permit what the
  configured policy already allows; it can never cross a non-overridable deny.
  Every tool call is prepared with its normalized resource set and access level,
  and a single denied target rejects the whole call.
- **Approval binding.** Each approval binds session/run/call id, a normalized
  input hash, the policy revision, scope and expiry. Only a client holding the
  controller capability may answer; the first valid answer commits and the rest
  return `already_resolved`.
- **Rewrite re-validation.** If a hook or controller rewrites input, the engine
  re-runs schema/resource/policy validation and rebuilds the approval. The old
  authorization is not reused, and late or cancelled replies are rejected.
- **Extensions declare authority.** Hooks, MCP tools and any compatibility
  worker state their execution authority; an MCP `readOnlyHint` is a scheduling
  hint, not an execution grant. The leaf that touches the filesystem or network
  performs the final authorization.
- **Sandbox is orthogonal to permission.** Sandbox profiles (`compat`,
  `workspace`, restricted) decide *containment*; permission decides *allow/deny*.
  The process tools require an actually enforced backend: macOS seatbelt and
  Linux Landlock. On a platform without an enforced backend the engine reports
  sandbox unavailable and disables the process tools rather than running
  unsandboxed.
- **No silent enforcement claims.** `doctor` reports what the engine can
  enforce: macOS seatbelt, Linux Landlock, and Windows AppContainer. A platform
  without an enforced backend keeps the process tools disabled rather than
  running unsandboxed.

## Consequences

- A compromised or confused client cannot widen authority past policy.
- Replay of an approval cannot authorize a mutated action.
- Capability degradation (no sandbox) is explicit, matching the roadmap rule
  that missing Windows enforcement must never be disguised as isolation.
