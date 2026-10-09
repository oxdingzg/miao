# ADR-05: Extension compatibility

Status: Accepted (MCP client in `src/mcp.rs`, hooks in `src/hooks.rs`; a TS
compatibility worker is planned).

## Context

The product already exposes MCP servers, hooks and custom tools. The Rust engine
must preserve that behaviour without embedding a general-purpose script runtime
on the main path, and every extension must sit behind the same authority, budget
and output governance as a built-in tool.

## Decision

- **MCP is a client.** The engine connects to MCP servers with an rmcp client and
  surfaces their tools like any other tool, subject to permission, output bounds
  and cancellation.
- **Hooks are bounded.** Hooks can deny, ask or rewrite at defined boundaries;
  automatic approval by a hook requires explicit configuration.
- **Compatibility worker is an optional bypass.** If a TS extension must run, it
  runs in an out-of-process worker invoked with a fixed capability interface, not
  an in-process JS runtime. The main engine does not depend on a script host.
- **Uniform governance.** MCP tools, hooks and the compatibility worker all
  declare execution authority and pass through permission, budget and bounded
  output handling. Catalog visibility is not execution authority.
- **Compatibility is a contract, not a port.** Behaviour that must match is
  captured as shared scenarios and re-implemented, not mechanically translated
  line for line.

## Consequences

- Extensions cannot widen authority or bypass output limits.
- The engine binary stays dependency-light; a missing extension host degrades a
  specific capability instead of the whole engine.
