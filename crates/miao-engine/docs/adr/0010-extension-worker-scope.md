# ADR-10: Extension compatibility worker scope

Status: Proposed (M3). Refines [ADR-05](0005-extension-compatibility.md), which
decided that a TypeScript extension must run out-of-process rather than in an
in-process JS runtime.

## Context

Extensions cover MCP servers, hooks, custom tools, and scripted batch/workflow
capabilities. MCP is already a native client and hooks are native; the remaining
gap is behaviour that only exists as product-side TypeScript (custom tools,
plugins, scripted batches). ADR-05 fixed the boundary — an optional
out-of-process worker, never an embedded script host — but not its interface.

## Decision

- **The worker is a process, invoked through a fixed capability interface.** The
  engine spawns it, negotiates a protocol revision, and calls a small, stable
  set of operations with declared inputs; it never loads a script runtime into
  the engine process.
- **Every call declares authority and is governed uniformly.** An invocation
  passes through the same permission, budget, timeout, cancellation and bounded
  output handling as a native tool (ADR-04). Catalog visibility is not execution
  authority.
- **Bounded and supervised.** Each call has an input bound, an output bound, a
  deadline and cooperative cancellation; a call that exceeds them is terminated
  and its capability degrades alone.
- **Optional and degradable.** A missing or crashed worker degrades the specific
  capability it serves; the engine and its built-in tools keep working. The
  engine never depends on a script host to start.
- **Versioned like any wire.** The worker interface is a negotiated revision
  with the same additive-only rule as ADR-07; unknown operations fail with a
  typed error.
- **Behaviour parity is a contract, not a port.** What must match is captured as
  shared scenarios (ADR-05) and re-implemented, not translated line for line.

The concrete transport (framing, launch, capability names) is fixed in the
implementing ADR before the first worker ships; this record fixes the boundary.

## Consequences

- TypeScript-defined behaviour stays available without widening engine authority
  or dependency weight.
- The engine can ship and be evaluated before any worker exists; workers are
  added per capability with their own acceptance.
- Deferred: which extension classes move first, and whether the worker is
  TypeScript-only or a generic subprocess protocol.
