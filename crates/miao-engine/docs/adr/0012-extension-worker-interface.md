# ADR-12: Extension worker interface

Status: Accepted (protocol revision 1; implemented by `src/worker.rs`). Implements
the boundary fixed by
[ADR-05](0005-extension-compatibility.md) and refined by
[ADR-10](0010-extension-worker-scope.md). This is the "implementing ADR" ADR-10
requires before the first worker ships: it fixes the transport, the launch
handshake and the capability names.

## Context

ADR-05 decided that a TypeScript extension must run out-of-process, never as an
in-process script host. ADR-10 fixed that boundary — one worker process, a fixed
capability interface, uniform governance, bounded and degradable — but left the
concrete transport to an implementing ADR. This record supplies it.

The engine already has one wire shape it trusts: newline-delimited JSON over
stdio, as in its own stdio adapter and MCP framing. Reusing that shape keeps the
worker a peer of existing adapters rather than a new paradigm, and keeps the
engine binary free of any script runtime.

## Decision

- **One worker process, launched by the engine.** The worker binary is a host
  configuration (`--worker-config`, read outside the model-writable workspace
  like the MCP/hooks/context configs); the engine spawns it and owns its
  lifetime. The engine never loads a script runtime in-process.

- **Transport: newline-delimited JSON over stdio.** One JSON object per line.
  Requests carry an `id` and a `method`; replies echo the `id` with `result` or
  `error`; the worker may emit `progress` notifications. Framing and error
  envelopes match the stdio adapter so tooling and bounds are shared.

- **Handshake negotiates a revision.** The engine's first line is
  `{"id":1,"method":"hello","params":{"protocol":1,"workspace":"<abs path>"}}`.
  The worker replies
  `{"id":1,"result":{"protocol":1,"operations":["tool.list","tool.call","shutdown"]}}`.
  A missing, unknown or higher protocol degrades the capability (typed error);
  the engine keeps running. Operations the engine does not know are ignored.

- **Capability set (minimal, additive).**
  - `tool.list` → `{tools:[{name, description, input_schema}]}`, bounded to 64
    tools and 64 KiB.
  - `tool.call {name, input}` → `{result}`; the call's output is bounded.
  - `shutdown` → graceful stop.
  These are the only operations in revision 1. New operations are additive with
  their own revision; unknown operations fail with a typed
  `unsupported_operation`.

- **Uniform governance.** Each worker tool is surfaced exactly like an MCP tool:
  `Access::External`, subject to the same permission/approval, deadline
  (1..120 000 ms), output bound (≤ 256 KiB) and cancellation. Catalog visibility
  is not execution authority; the leaf that acts performs the final
  authorization (ADR-04).

- **Bounded and supervised.** Every call has an input bound (≤ 256 KiB), an
  output bound, a deadline and cooperative cancellation: the engine sends
  `{"method":"cancel","params":{"id":N}}`, then terminates the worker if the
  deadline passes. A worker that exceeds a bound is stopped and its capability
  degrades alone.

- **Degradable.** A missing, crashed, hung or protocol-incompatible worker
  removes the capabilities it serves; the engine, its built-in tools and the
  provider loop keep working. The engine never depends on a worker to start.

- **Non-goals.** No in-process script runtime; no byte-for-byte plugin API port
  (behaviour that must match is captured as shared scenarios and re-implemented,
  ADR-05); the worker is not a place to widen authority or bypass output limits.

## Transport and launch (normative summary)

```
engine -> worker   {"id":1,"method":"hello","params":{"protocol":1,"workspace":"<abs>"}}
worker -> engine   {"id":1,"result":{"protocol":1,"operations":["tool.list","tool.call","shutdown"]}}

engine -> worker   {"id":2,"method":"tool.list"}
worker -> engine   {"id":2,"result":{"tools":[{"name":"...","description":"...","input_schema":{}}]}}

engine -> worker   {"id":3,"method":"tool.call","params":{"name":"...","input":{}}}
worker -> engine   {"method":"progress","params":{"id":3,"stage":"..."}}   # optional
worker -> engine   {"id":3,"result":{"result":{}}}

engine -> worker   {"id":4,"method":"shutdown"}
```

## Consequences

- The engine gains custom-tool coverage without embedding a script host, and a
  worker failure degrades one capability instead of the binary.
- The interface is small and versioned, so it can grow additively as ADR-10
  anticipates, and it reuses the framing, bounds and governance already applied
  to MCP.
- Implementing the worker is a separate change; this record only fixes the
  interface, as ADR-10 requires.
