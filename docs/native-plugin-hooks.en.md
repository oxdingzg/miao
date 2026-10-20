# Plugin tool hooks for engine-owned Sessions

[Roadmap](roadmap.md) §9 gate 2's reverse bridge covers product tools; this
document designs the last plugin-surface gap: hooks that plugins register at
runtime (`host.tool.definition`, and the `before`/`after` pair exposed at
`packages/core/src/plugin/host.ts`) do not execute around tool calls in
engine-owned Sessions.

## 1. What already works

- **Config lifecycle hooks** travel in the declarative hooks manifest
  (`ProductHooks.prepare`, capped at 16 entries) and the engine executes them
  natively.
- **Plugin tools** run through the ADR-12 extension worker; their definitions
  reach engine-owned Sessions today.

The gap is precisely the hooks plugins register as **in-process TypeScript
closures** during boot. The hooks manifest is declarative (commands); a
closure cannot be serialized into it, so these hooks silently never fire for
a Session drained by the engine.

## 2. Design: reverse hook dispatch

The pattern is the product-tool bridge applied to hooks:

1. **Advertising.** `ProductHooks.prepare` inspects the loaded plugin
   runtime's hook registry and adds a host-resolved marker to the hooks
   manifest: which tool-scoped hook families (definition / before / after)
   have at least one registered callback, and for which tool names. The
   engine learns nothing about the callbacks themselves.
2. **Dispatch.** Around a tool call that the manifest marks host-resolved,
   the engine emits a `hook_tool` control request — hook kind, tool name,
   tool-call id, Session id, and the input (for `before`/`definition`) or the
   settled output (for `after`) — and awaits the reply, exactly like
   `Bridge::call` settles product tools. A missing or dropped host reply
   fails closed, matching the engine's existing hook failure semantics.
3. **Execution.** The host executor resolves the registered callbacks from
   the plugin runtime registry in registration order and replies with the
   familiar hook verdicts (allow / deny with reason / transformed value).
   Permission evaluation ordering is unchanged: `before` hooks run before the
   engine's approval flow, `after` after settlement — the same relative order
   the TS runner guarantees today.

## 3. Engine changes

1. The hooks manifest gains the host-resolved marker (kind + tool-name set).
2. `crates/miao-engine/src/tools.rs` (or the worker call site for ADR-12
   tools) emits `hook_tool` requests around marked calls and settles the
   reply durably, reusing the product bridge's pending/reply mechanics
   including the cancellation drop rule.
3. Tests: a marked tool runs its before/after in registration order; a
   denied `before` blocks the call; a dropped reply fails the call closed;
   an unmarked tool never dispatches.

## 4. Host changes

1. `ProductHooks.prepare` reads the plugin runtime's registry (it already
   boots plugins deferred) and builds the marker.
2. The executor holds `(plugin, hook kind, tool name) → callback[]` and
   answers `hook_tool` requests; plugin unload tears the registrations down
   and the marker refreshes on the next prepare/refresh cycle.
3. Non-tool hook families (session lifecycle, prompt hooks) stay declarative
   and out of scope.

## 5. Non-goals

- Plugins never execute engine-side; the interpreter boundary of the
  workflow bridge design applies here too.
- No hook execution for host-owned tools (the TS runner keeps running those
  hooks in-process).
- No serialization of closures, ever; the engine only ever sees a marker.

## 6. Acceptance

- An engine-owned Session calls a worker tool wrapped by a plugin's
  before/after hooks: both fire in registration order, a denial blocks the
  call with the plugin's reason, and the durable journal records the hook
  outcomes.
- A Session draining while the plugin unloads fails the pending hook closed
  and completes the run without orphaned dispatches.
- TS-placed Sessions are byte-for-byte unaffected.
